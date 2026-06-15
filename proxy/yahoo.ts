// Yahoo Finance 5分足 CORS プロキシ（保存なし・中継のみ）
//
// デプロイ（どちらも 0 円）:
//   ・Val.town : 新規 HTTP val にこの内容を貼るだけ。発行URLが proxyBase。
//   ・Deno Deploy : このファイルをデプロイ。末尾の Deno.serve(handler) が有効。
//   ・ローカル : nix-shell -p deno --run "deno run -A proxy/yahoo.ts"
//
// フロントは `${proxyBase}?symbol=7203.T&range=60d&interval=5m` を叩く。
// 全銘柄をその場で取得するだけでデータは一切保存しない（容量問題が発生しない）。

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Yahoo の同意 Cookie をウォームインスタンス内で使い回す
let cookie = "";
let cookieAt = 0;
async function ensureCookie(): Promise<void> {
  if (cookie && Date.now() - cookieAt < 3_600_000) return;
  try {
    const r = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA } });
    const sc = r.headers.get("set-cookie");
    if (sc) { cookie = sc.split(";")[0]; cookieAt = Date.now(); }
  } catch { /* Cookie なしでも chart は通ることが多い */ }
}

// 同一銘柄の短期キャッシュ（Yahoo への負荷とレート制限を緩和）
const cache = new Map<string, { at: number; body: string }>();
const TTL = 60_000;

const SYMBOL_RE = /^[0-9A-Za-z]{1,6}\.[A-Z]{1,2}$/; // 7203.T / 130A.T など

export default async function handler(req: Request): Promise<Response> {
  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").trim();
  const range = url.searchParams.get("range") || "60d";
  const interval = url.searchParams.get("interval") || "5m";
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), {
      status, headers: { ...cors, "Content-Type": "application/json" },
    });

  if (!SYMBOL_RE.test(symbol)) return json({ error: "bad symbol" }, 400);
  if (!/^[0-9a-z]+$/.test(range) || !/^[0-9a-z]+$/.test(interval))
    return json({ error: "bad params" }, 400);

  const key = `${symbol}|${range}|${interval}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL)
    return new Response(hit.body, { headers: { ...cors, "Content-Type": "application/json" } });

  await ensureCookie();
  const y =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}`;
  try {
    const yr = await fetch(y, {
      headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const body = await yr.text();
    if (yr.ok) cache.set(key, { at: Date.now(), body });
    return new Response(body, {
      status: yr.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
}

// Deno Deploy / ローカル deno run 用（Val.town では無害に無視される）
// deno-lint-ignore no-explicit-any
if (typeof (globalThis as any).Deno?.serve === "function") {
  // deno-lint-ignore no-explicit-any
  (globalThis as any).Deno.serve(handler);
}
