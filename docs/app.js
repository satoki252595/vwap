"use strict";

const DATA = "./data";
const $ = (id) => document.getElementById(id);

// 全角ASCII→半角・小文字・空白除去(コード/名称検索の正規化)
const norm = (s) =>
  String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .toLowerCase()
    .trim();

const fmtInt = (n) => Math.round(n).toLocaleString("ja-JP");
const jstTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false,
});
const jstDateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

let chart, candleSeries, vwapSeries, volSeries;
let profileLines = [];
let currentProfile = null;
const show = { vwap: true, profile: true, volume: true };

let master = [];                 // [{code,name,seg,nname}]
let haveCodes = new Set();       // データ取得済みコード
let tickerByCode = new Map();    // code -> index.json の ticker
let curCode = null, curName = "";
let period = "day";              // "day" | "c<N>"
let windows = [];                // 集計期間(例 [5,20,60])

// --------------------------------------------------------------- chart init
function initChart() {
  chart = LightweightCharts.createChart($("chart"), {
    layout: { background: { color: "#ffffff" }, textColor: "#475569",
              fontSize: 12, attributionLogo: false },
    grid: { vertLines: { color: "#eef2f7" }, horzLines: { color: "#eef2f7" } },
    rightPriceScale: { borderColor: "#e2e8f0" },
    timeScale: {
      borderColor: "#e2e8f0", timeVisible: true, secondsVisible: false,
      tickMarkFormatter: (t) => jstTime.format(t * 1000),
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: {
      timeFormatter: (t) => jstDateTime.format(t * 1000),
      priceFormatter: (p) => fmtInt(p),
    },
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: "#089981", downColor: "#f23645",
    wickUpColor: "#089981", wickDownColor: "#f23645", borderVisible: false,
    priceFormat: { type: "price", precision: 0, minMove: 1 },
  });
  vwapSeries = chart.addLineSeries({
    color: "#2563eb", lineWidth: 2, priceLineVisible: false,
    lastValueVisible: true, title: "VWAP",
    priceFormat: { type: "price", precision: 0, minMove: 1 },
  });
  volSeries = chart.addHistogramSeries({
    priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false,
  });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  new ResizeObserver(resizeOverlay).observe($("chartWrap"));
  requestAnimationFrame(drawLoop);
}

// --------------------------------------------------------------- overlay
function resizeOverlay() {
  const c = $("overlay");
  const r = $("chartWrap").getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr;
  c.style.width = r.width + "px"; c.style.height = r.height + "px";
  c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}
function drawLoop() { drawProfile(); requestAnimationFrame(drawLoop); }

function drawProfile() {
  const c = $("overlay");
  const ctx = c.getContext("2d");
  const w = c.clientWidth, h = c.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!currentProfile || !candleSeries || !show.profile) return;

  const prof = currentProfile;
  const plotW = w - chart.priceScale("right").width();
  const maxLen = plotW * 0.30;
  const maxVol = Math.max(...prof.bins.map((b) => b.volume)) || 1;
  const half = prof.binSize / 2;

  for (const bin of prof.bins) {
    if (bin.volume <= 0) continue;
    const yTop = candleSeries.priceToCoordinate(bin.price + half);
    const yBot = candleSeries.priceToCoordinate(bin.price - half);
    if (yTop == null || yBot == null) continue;
    const top = Math.min(yTop, yBot);
    const bh = Math.max(1, Math.abs(yBot - yTop) - 1);
    const len = (bin.volume / maxVol) * maxLen;
    const inVA = bin.price >= prof.val && bin.price <= prof.vah;
    const isPOC = Math.abs(bin.price - prof.poc) < 1e-9;
    ctx.fillStyle = isPOC ? "rgba(245,158,11,0.80)"
      : inVA ? "rgba(37,99,235,0.26)" : "rgba(148,163,184,0.30)";
    ctx.fillRect(0, top, len, bh);
  }
}

function setProfileLines(prof) {
  for (const l of profileLines) candleSeries.removePriceLine(l);
  profileLines = [];
  if (!prof) return;
  const add = (price, color, title, style) =>
    profileLines.push(candleSeries.createPriceLine({
      price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title,
    }));
  add(prof.poc, "#f59e0b", "POC", LightweightCharts.LineStyle.Solid);
  add(prof.vah, "#94a3b8", "VAH", LightweightCharts.LineStyle.Dashed);
  add(prof.val, "#94a3b8", "VAL", LightweightCharts.LineStyle.Dashed);
}

function applyVisibility() {
  if (vwapSeries) vwapSeries.applyOptions({ visible: show.vwap });
  if (volSeries) volSeries.applyOptions({ visible: show.volume });
  setProfileLines(show.profile ? currentProfile : null);
}

// --------------------------------------------------------------- data load
async function boot() {
  const [idx, stk] = await Promise.all([
    fetch(`${DATA}/index.json`, { cache: "no-store" }).then((r) => r.json()).catch(() => ({ tickers: [], updated: "" })),
    fetch(`${DATA}/stocks.json`, { cache: "no-store" }).then((r) => r.json()),
  ]);
  master = stk.stocks.map(([code, name, seg]) =>
    ({ code, name, seg, nname: norm(name), ncode: code.toLowerCase() }));
  for (const t of idx.tickers) {
    const code = t.symbol.replace(/\.T$/, "");
    haveCodes.add(code);
    tickerByCode.set(code, t);
  }
  windows = idx.composites || [];
  buildPeriodControl();
  $("updated").textContent =
    `データ更新: ${idx.updated || "-"} ／ 検索対象 ${master.length.toLocaleString()} 銘柄（東証全上場）／ 収集済み ${haveCodes.size} 銘柄`;

  // 初期表示は収集済みの先頭
  const first = master.find((m) => haveCodes.has(m.code)) || master[0];
  if (first) selectCode(first.code);
  renderSuggest("");
}

// --------------------------------------------------------------- search
function searchHits(query) {
  const q = norm(query);
  // 空 → 収集済み一覧。それ以外はコード/名称の部分一致(大小文字無視)。
  const list = !q
    ? master.filter((m) => haveCodes.has(m.code))
    : master.filter((m) => m.ncode.includes(q) || m.nname.includes(q));
  const pref = (m) => (m.ncode.startsWith(q) || m.nname.startsWith(q)) ? 0 : 1;
  // 収集済み優先 → 前方一致優先 → コード昇順
  list.sort((a, b) =>
    (haveCodes.has(b.code) - haveCodes.has(a.code)) ||
    (pref(a) - pref(b)) ||
    a.code.localeCompare(b.code));
  return list.slice(0, 40);
}

let activeIdx = -1;
function renderSuggest(query) {
  const ul = $("suggest");
  const hits = searchHits(query);
  activeIdx = -1;
  if (!hits.length) {
    ul.innerHTML = `<li class="empty-hint">該当なし</li>`;
    return;
  }
  ul.innerHTML = hits.map((m, i) => `
    <li data-code="${m.code}" data-i="${i}">
      <span class="code">${m.code}</span>
      <span class="nm">${m.name}</span>
      ${haveCodes.has(m.code) ? `<span class="have">収集済み</span>` : `<span class="seg">${m.seg}</span>`}
    </li>`).join("");
}
function openSuggest() { renderSuggest($("q").value); $("suggest").hidden = false; }
function closeSuggest() { $("suggest").hidden = true; }
function moveActive(d) {
  const items = [...$("suggest").querySelectorAll("li[data-code]")];
  if (!items.length) return;
  items[activeIdx]?.classList.remove("active");
  activeIdx = (activeIdx + d + items.length) % items.length;
  items[activeIdx].classList.add("active");
  items[activeIdx].scrollIntoView({ block: "nearest" });
}
function commitActive() {
  const items = [...$("suggest").querySelectorAll("li[data-code]")];
  const el = items[activeIdx < 0 ? 0 : activeIdx];
  if (el) { selectCode(el.dataset.code); closeSuggest(); $("q").blur(); }
}

// --------------------------------------------------------------- select / render
function selectCode(code) {
  const m = master.find((x) => x.code === code);
  curCode = code; curName = m ? m.name : code;
  $("q").value = m ? `${code}  ${m.name}` : code;
  if (haveCodes.has(code)) { populateDates(); render(); }
  else showEmpty();
}

function populateDates() {
  const t = tickerByCode.get(curCode);
  const sel = $("date");
  sel.innerHTML = [...t.days].reverse().map((d) => `<option value="${d}">${d}</option>`).join("");
}

async function render() {
  if (!haveCodes.has(curCode)) return showEmpty();
  $("empty").hidden = true;
  const symbol = `${curCode}.T`;
  const date = $("date").value;
  if (!date) return;

  const day = await fetch(`${DATA}/${symbol}/${date}.json`, { cache: "no-store" }).then((r) => r.json());
  candleSeries.setData(day.bars.map((b) => ({ time: b.ts, open: b.o, high: b.h, low: b.l, close: b.c })));
  vwapSeries.setData(day.bars.map((b) => ({ time: b.ts, value: b.vwap })));
  volSeries.setData(day.bars.map((b) => ({
    time: b.ts, value: b.v,
    color: b.c >= b.o ? "rgba(8,153,129,0.45)" : "rgba(242,54,69,0.45)",
  })));
  chart.timeScale().fitContent();

  let prof = day.profile;
  let profLabel = "当日";
  const t = tickerByCode.get(curCode);
  const w = period.startsWith("c") ? Number(period.slice(1)) : 0;
  if (w && (t.composites || []).includes(w)) {
    try {
      const comp = await fetch(`${DATA}/${symbol}/composite_${w}.json`, { cache: "no-store" }).then((r) => r.json());
      prof = comp.profile; profLabel = `直近${w}日`;
    } catch { /* フォールバック: 当日 */ }
  }
  currentProfile = prof;
  applyVisibility();

  const last = day.bars[day.bars.length - 1];
  const first = day.bars[0];
  const chg = last.c - first.o;
  const dev = ((last.c - last.vwap) / last.vwap) * 100;
  const cls = (x) => (x >= 0 ? "up" : "down");
  const sign = (x) => (x >= 0 ? "+" : "");
  $("meta").innerHTML = `
    <div class="stat"><span class="k">銘柄</span><span class="name"><span class="c">${curCode}</span>${curName}</span></div>
    <div class="stat"><span class="k">終値（${date}）</span><span class="v ${cls(chg)}">${fmtInt(last.c)} <span style="font-size:13px">${sign(chg)}${fmtInt(chg)}</span></span></div>
    <div class="stat"><span class="k">VWAP</span><span class="v vwap sub">${fmtInt(last.vwap)}</span></div>
    <div class="stat"><span class="k">VWAP乖離</span><span class="v sub ${cls(dev)}">${sign(dev)}${dev.toFixed(1)}%</span></div>
    <div class="stat"><span class="k">POC（${profLabel}）</span><span class="v poc sub">${fmtInt(prof.poc)}</span></div>
    <div class="stat"><span class="k">バリューエリア</span><span class="v sub">${fmtInt(prof.val)} 〜 ${fmtInt(prof.vah)}</span></div>`;
}

function buildPeriodControl() {
  const opts = [{ v: "day", label: "当日" }].concat(
    windows.map((w) => ({ v: `c${w}`, label: `直近${w}日` })));
  $("period").innerHTML = opts.map((o) =>
    `<button class="seg-btn${o.v === period ? " on" : ""}" data-v="${o.v}">${o.label}</button>`).join("");
}

function showEmpty() {
  currentProfile = null;
  candleSeries.setData([]); vwapSeries.setData([]); volSeries.setData([]);
  setProfileLines(null);
  $("date").innerHTML = "";
  $("meta").innerHTML = `<div class="stat"><span class="k">銘柄</span><span class="name"><span class="c">${curCode}</span>${curName}</span></div>`;
  $("empty").hidden = false;
  $("empty").innerHTML = `
    <div class="big">この銘柄はまだ収集していません</div>
    <div class="sub">チャート表示は収集対象（監視リスト）の銘柄のみです。</div>
    <div class="sub"><code>config/tickers.json</code> に <code>{ "symbol": "${curCode}.T", "name": "${curName}" }</code> を追加すると、次回の収集から表示されます。</div>`;
}

// --------------------------------------------------------------- events
const q = $("q");
const selLabel = () => {
  const m = master.find((x) => x.code === curCode);
  return m ? `${curCode}  ${m.name}` : (curCode || "");
};
// フォーカス時は現在の銘柄表示を消してすぐ検索できる状態に
q.addEventListener("focus", () => { q.value = ""; openSuggest(); });
q.addEventListener("blur", () => setTimeout(() => { closeSuggest(); q.value = selLabel(); }, 120));
q.addEventListener("input", () => renderSuggest(q.value));
q.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); moveActive(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); }
  else if (e.key === "Enter") { e.preventDefault(); commitActive(); }
  else if (e.key === "Escape") { closeSuggest(); q.blur(); }
});
$("suggest").addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-code]");
  if (li) { e.preventDefault(); selectCode(li.dataset.code); closeSuggest(); q.blur(); }
});
document.addEventListener("click", (e) => { if (!$("search").contains(e.target)) closeSuggest(); });

$("date").addEventListener("change", render);
$("period").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn");
  if (!b) return;
  period = b.dataset.v;
  $("period").querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("on", x === b));
  render();
});
for (const btn of document.querySelectorAll(".toggle")) {
  btn.addEventListener("click", () => {
    const k = btn.dataset.key;
    show[k] = !show[k];
    btn.classList.toggle("on", show[k]);
    applyVisibility();
  });
}

initChart();
resizeOverlay();
boot().catch((e) => { $("meta").textContent = "読み込みに失敗しました: " + e; });
