// VWAP Worker: 静的フロント同居 + /api/* + Cron(日足/信用残高) + R2蓄積
import { fetchChartRaw, fetchDaily } from "./yahoo";
import { fetchMargin } from "./margin";

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  BUCKET: any;            // R2Bucket
  DAILY_BATCH: string;
  ADMIN_TOKEN: string;
}

const CORS = { "Access-Control-Allow-Origin": "*" };
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });
const SYMBOL_RE = /^[0-9A-Za-z]{1,6}\.[A-Z]{1,2}$/;

// ---- 銘柄リスト（静的 stocks.json から）----
let CODES: string[] | null = null;
async function loadCodes(env: Env): Promise<string[]> {
  if (CODES) return CODES;
  const r = await env.ASSETS.fetch(new Request("https://assets/data/stocks.json"));
  const j: any = await r.json();
  CODES = j.stocks.map((s: any[]) => s[0]);
  return CODES!;
}

// ---- R2 カーソル ----
async function readCursor(env: Env): Promise<number> {
  const o = await env.BUCKET.get("meta/daily_cursor");
  return o ? parseInt(await o.text(), 10) || 0 : 0;
}
async function writeCursor(env: Env, i: number) {
  await env.BUCKET.put("meta/daily_cursor", String(i));
}

// ---- 日足: 1チャンク取得（バックフィル/差分）----
async function ingestDailyChunk(env: Env, n: number) {
  const codes = await loadCodes(env);
  const cur = await readCursor(env);
  let written = 0, empty = 0, errors = 0;
  for (let k = 0; k < n; k++) {
    const code = codes[(cur + k) % codes.length];
    try {
      const existing = await env.BUCKET.get(`daily/${code}.json`);
      const { bars, splits } = await fetchDaily(`${code}.T`, existing ? "1mo" : "10y");
      if (!bars.length) { empty++; continue; }
      let merged = bars;
      if (existing) {
        const old: any = JSON.parse(await existing.text());
        const map = new Map<string, any>((old.bars || []).map((b: any) => [b.date, b]));
        for (const b of bars) map.set(b.date, b);
        merged = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
      }
      await env.BUCKET.put(`daily/${code}.json`,
        JSON.stringify({ code, updated: new Date().toISOString(), bars: merged, splits }));
      written++;
    } catch { errors++; }
  }
  const next = (cur + n) % codes.length;
  await writeCursor(env, next);
  return { total: codes.length, from: cur, processed: n, written, empty, errors, cursorNow: next };
}

// ---- 信用残高: 週次PDFを取込み週スナップショットを保存 ----
async function ingestMargin(env: Env) {
  const { week, rows } = await fetchMargin();
  if (!week || !rows.length) throw new Error("margin parse empty");
  await env.BUCKET.put(`margin/${week}.json`, JSON.stringify({ week, rows }));
  const wl = await env.BUCKET.get("margin/weeks.json");
  const weeks: string[] = wl ? JSON.parse(await wl.text()) : [];
  if (!weeks.includes(week)) weeks.push(week);
  weeks.sort();
  await env.BUCKET.put("margin/weeks.json", JSON.stringify(weeks));
  return { week, count: rows.length };
}

async function marginForCode(env: Env, code: string, limit = 16) {
  const wl = await env.BUCKET.get("margin/weeks.json");
  if (!wl) return [];
  const weeks: string[] = JSON.parse(await wl.text()).slice(-limit);
  const out: any[] = [];
  for (const w of weeks) {
    const o = await env.BUCKET.get(`margin/${w}.json`);
    if (!o) continue;
    const snap: any = JSON.parse(await o.text());
    const row = snap.rows.find((r: any) => r.code === code);
    if (row) out.push({ week: w, ...row });
  }
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/api/chart") {
      const symbol = (url.searchParams.get("symbol") || "").trim();
      if (!SYMBOL_RE.test(symbol)) return json({ error: "bad symbol" }, 400);
      const r = await fetchChartRaw(symbol, url.searchParams.get("range") || "60d", url.searchParams.get("interval") || "5m");
      return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json", ...CORS } });
    }
    if (p === "/api/daily") {
      const code = (url.searchParams.get("code") || "").trim();
      const o = await env.BUCKET.get(`daily/${code}.json`);
      if (!o) return json({ code, bars: [], note: "未取得（バックフィル待ち）" });
      return new Response(o.body, { headers: { "Content-Type": "application/json", ...CORS } });
    }
    if (p === "/api/margin") {
      const code = (url.searchParams.get("code") || "").trim();
      return json({ code, weeks: await marginForCode(env, code) });
    }
    if (p.startsWith("/api/admin/")) {
      if (url.searchParams.get("token") !== env.ADMIN_TOKEN) return json({ error: "unauthorized" }, 401);
      try {
        if (p === "/api/admin/ingest-margin") return json(await ingestMargin(env));
        if (p === "/api/admin/backfill-daily")
          return json(await ingestDailyChunk(env, parseInt(url.searchParams.get("n") || env.DAILY_BATCH, 10)));
        if (p === "/api/admin/backfill-one") {
          const code = (url.searchParams.get("code") || "").trim();
          const { bars, splits } = await fetchDaily(`${code}.T`, "10y");
          if (!bars.length) return json({ code, written: 0 });
          await env.BUCKET.put(`daily/${code}.json`,
            JSON.stringify({ code, updated: new Date().toISOString(), bars, splits }));
          return json({ code, bars: bars.length, from: bars[0].date, to: bars[bars.length - 1].date });
        }
      } catch (e) { return json({ error: String(e) }, 500); }
      return json({ error: "unknown admin route" }, 404);
    }
    return env.ASSETS.fetch(req); // 静的アセット
  },

  async scheduled(event: { cron: string }, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }) {
    if (event.cron === "0 8 * * 2") ctx.waitUntil(ingestMargin(env).catch((e) => console.error("margin", e)));
    else ctx.waitUntil(ingestDailyChunk(env, parseInt(env.DAILY_BATCH, 10)).catch((e) => console.error("daily", e)));
  },
};
