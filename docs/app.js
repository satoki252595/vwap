"use strict";

const $ = (id) => document.getElementById(id);

// 全角ASCII→半角・小文字・空白除去（コード/名称検索の正規化）
const norm = (s) =>
  String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ").toLowerCase().trim();

const fmtInt = (n) => Math.round(n).toLocaleString("ja-JP");
const jstTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
const jstDateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false });
const jstDate = (ts) => new Date((ts + 32400) * 1000).toISOString().slice(0, 10);

let chart, candleSeries, vwapSeries, volSeries;
let profileLines = [];
let currentProfile = null;
const show = { vwap: true, profile: true, volume: true };

let cfg = { proxyBase: "", fetchRange: "60d", profileBins: 50, valueAreaPercent: 0.7, compositeWindows: [5, 20, 60], favorites: [] };
let master = [];                 // [{code,name,seg,nname,ncode}]
let codeToName = new Map();
let curCode = null, curName = "";
let period = "day";              // "day" | "c<N>"
let dataset = null;              // { code, dates:[...], byDay:Map(date->bars) }

// ===================================================================== 計算
function addVwap(bars) {
  let pv = 0, vv = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v; vv += b.v;
    b.vwap = vv ? +(pv / vv).toFixed(2) : b.c;
  }
  return bars;
}

function volumeProfile(bars, nbins, vaPct) {
  if (!bars.length) return null;
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  if (hi <= lo) hi = lo + 1;
  const binSize = (hi - lo) / nbins;
  const vols = new Array(nbins).fill(0);
  for (const b of bars) {
    const span = b.h - b.l;
    if (span <= 0) { vols[Math.min(nbins - 1, Math.floor((b.l - lo) / binSize))] += b.v; continue; }
    const first = Math.max(0, Math.floor((b.l - lo) / binSize));
    const last = Math.min(nbins - 1, Math.floor((b.h - lo) / binSize));
    for (let i = first; i <= last; i++) {
      const blo = lo + i * binSize, bhi = blo + binSize;
      const ov = Math.min(b.h, bhi) - Math.max(b.l, blo);
      if (ov > 0) vols[i] += b.v * (ov / span);
    }
  }
  const centers = vols.map((_, i) => +(lo + (i + 0.5) * binSize).toFixed(2));
  let poc = 0; for (let i = 1; i < nbins; i++) if (vols[i] > vols[poc]) poc = i;
  const total = vols.reduce((a, b) => a + b, 0);
  let loI = poc, hiI = poc, acc = vols[poc];
  const target = total * vaPct;
  while (acc < target && (loI > 0 || hiI < nbins - 1)) {
    const below = loI > 0 ? vols[loI - 1] : -1;
    const above = hiI < nbins - 1 ? vols[hiI + 1] : -1;
    if (above >= below) acc += vols[++hiI]; else acc += vols[--loI];
  }
  return {
    binSize: +binSize.toFixed(4),
    bins: centers.map((price, i) => ({ price, volume: Math.round(vols[i]) })),
    poc: centers[poc], vah: centers[hiI], val: centers[loI],
  };
}

function parseYahoo(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) return [];
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if (o == null || h == null || l == null || c == null || !v) continue;
    out.push({ ts: r.timestamp[i], o, h, l, c, v });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// ===================================================================== chart
function initChart() {
  chart = LightweightCharts.createChart($("chart"), {
    layout: { background: { color: "#ffffff" }, textColor: "#475569", fontSize: 12, attributionLogo: false },
    grid: { vertLines: { color: "#eef2f7" }, horzLines: { color: "#eef2f7" } },
    rightPriceScale: { borderColor: "#e2e8f0" },
    timeScale: { borderColor: "#e2e8f0", timeVisible: true, secondsVisible: false,
      tickMarkFormatter: (t) => jstTime.format(t * 1000) },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { timeFormatter: (t) => jstDateTime.format(t * 1000), priceFormatter: (p) => fmtInt(p) },
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: "#089981", downColor: "#f23645", wickUpColor: "#089981", wickDownColor: "#f23645",
    borderVisible: false, priceFormat: { type: "price", precision: 0, minMove: 1 } });
  vwapSeries = chart.addLineSeries({
    color: "#2563eb", lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: "VWAP",
    priceFormat: { type: "price", precision: 0, minMove: 1 } });
  volSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  new ResizeObserver(resizeOverlay).observe($("chartWrap"));
  requestAnimationFrame(drawLoop);
}

function resizeOverlay() {
  const c = $("overlay"), r = $("chartWrap").getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr;
  c.style.width = r.width + "px"; c.style.height = r.height + "px";
  c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}
function drawLoop() { drawProfile(); requestAnimationFrame(drawLoop); }
function drawProfile() {
  const c = $("overlay"), ctx = c.getContext("2d"), w = c.clientWidth, h = c.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!currentProfile || !candleSeries || !show.profile) return;
  const prof = currentProfile;
  const maxLen = (w - chart.priceScale("right").width()) * 0.30;
  const maxVol = Math.max(...prof.bins.map((b) => b.volume)) || 1;
  const half = prof.binSize / 2;
  for (const bin of prof.bins) {
    if (bin.volume <= 0) continue;
    const yT = candleSeries.priceToCoordinate(bin.price + half);
    const yB = candleSeries.priceToCoordinate(bin.price - half);
    if (yT == null || yB == null) continue;
    const top = Math.min(yT, yB), bh = Math.max(1, Math.abs(yB - yT) - 1);
    const len = (bin.volume / maxVol) * maxLen;
    const inVA = bin.price >= prof.val && bin.price <= prof.vah;
    const isPOC = Math.abs(bin.price - prof.poc) < 1e-9;
    ctx.fillStyle = isPOC ? "rgba(245,158,11,0.80)" : inVA ? "rgba(37,99,235,0.26)" : "rgba(148,163,184,0.30)";
    ctx.fillRect(0, top, len, bh);
  }
}
function setProfileLines(prof) {
  for (const l of profileLines) candleSeries.removePriceLine(l);
  profileLines = [];
  if (!prof) return;
  const add = (price, color, title, style) => profileLines.push(
    candleSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
  add(prof.poc, "#f59e0b", "POC", LightweightCharts.LineStyle.Solid);
  add(prof.vah, "#94a3b8", "VAH", LightweightCharts.LineStyle.Dashed);
  add(prof.val, "#94a3b8", "VAL", LightweightCharts.LineStyle.Dashed);
}
function applyVisibility() {
  if (vwapSeries) vwapSeries.applyOptions({ visible: show.vwap });
  if (volSeries) volSeries.applyOptions({ visible: show.volume });
  setProfileLines(show.profile ? currentProfile : null);
}

// ===================================================================== boot
async function boot() {
  cfg = Object.assign(cfg, await fetch("./config.json", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})));
  const stk = await fetch("./data/stocks.json", { cache: "no-store" }).then((r) => r.json());
  master = stk.stocks.map(([code, name, seg]) =>
    ({ code, name, seg, nname: norm(name), ncode: code.toLowerCase() }));
  for (const m of master) codeToName.set(m.code, m.name);
  buildPeriodControl();
  $("updated").textContent =
    `全 ${master.length.toLocaleString()} 銘柄（東証全上場） ／ 5分足オンデマンド + 日足/信用残高は蓄積（Yahoo Finance / JPX）`;
  const first = (cfg.favorites || []).find((c) => codeToName.has(c)) || (master[0] && master[0].code);
  if (first) selectCode(first);
  renderSuggest("");
}

// ===================================================================== search
function searchHits(query) {
  const q = norm(query);
  let list;
  if (!q) {
    const favs = (cfg.favorites || []).map((c) => master.find((m) => m.code === c)).filter(Boolean);
    list = favs.length ? favs : master.slice(0, 40);
    return list.slice(0, 40);
  }
  list = master.filter((m) => m.ncode.includes(q) || m.nname.includes(q));
  const pref = (m) => (m.ncode.startsWith(q) || m.nname.startsWith(q)) ? 0 : 1;
  list.sort((a, b) => (pref(a) - pref(b)) || a.code.localeCompare(b.code));
  return list.slice(0, 40);
}
let activeIdx = -1;
function renderSuggest(query) {
  const ul = $("suggest"); const hits = searchHits(query); activeIdx = -1;
  ul.innerHTML = hits.length
    ? hits.map((m) => `<li data-code="${m.code}"><span class="code">${m.code}</span><span class="nm">${m.name}</span><span class="seg">${m.seg}</span></li>`).join("")
    : `<li class="empty-hint">該当なし</li>`;
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

// ===================================================================== select / fetch / render
function selectCode(code) {
  curCode = code; curName = codeToName.get(code) || code;
  $("q").value = `${code}  ${curName}`;
  loadSymbol(code);
}

function statusEmpty(big, sub) {
  currentProfile = null;
  candleSeries.setData([]); vwapSeries.setData([]); volSeries.setData([]); setProfileLines(null);
  $("date").innerHTML = "";
  $("meta").innerHTML = `<div class="stat"><span class="k">銘柄</span><span class="name"><span class="c">${curCode}</span>${curName}</span></div>`;
  $("empty").hidden = false;
  $("empty").innerHTML = `<div class="big">${big}</div>${sub ? `<div class="sub">${sub}</div>` : ""}`;
}

async function loadSymbol(code) {
  dataset = null;
  statusEmpty("読み込み中…", `${code} のデータを取得しています`);
  const api = cfg.apiBase || "";   // 同一オリジン(Worker)なら空
  const url = `${api}/api/chart?symbol=${encodeURIComponent(code + ".T")}&range=${cfg.fetchRange || "60d"}&interval=5m`;
  let bars;
  try {
    bars = parseYahoo(await fetch(url, { cache: "no-store" }).then((r) => r.json()));
  } catch (e) {
    return statusEmpty("取得に失敗しました", "プロキシURLやネットワークをご確認ください: " + e);
  }
  if (code !== curCode) return;          // 取得中に別銘柄へ切替
  if (!bars.length) return statusEmpty("データがありません", "この銘柄は5分足データが取得できませんでした（新規上場・低流動性など）。");

  const byDay = new Map();
  for (const b of bars) { const d = jstDate(b.ts); (byDay.get(d) || byDay.set(d, []).get(d)).push(b); }
  const dates = [...byDay.keys()].sort();
  for (const d of dates) addVwap(byDay.get(d));
  dataset = { code, dates, byDay };

  $("date").innerHTML = [...dates].reverse().map((d) => `<option value="${d}">${d}</option>`).join("");
  $("empty").hidden = true;
  render();
}

function render() {
  if (!dataset) return;
  const date = $("date").value || dataset.dates[dataset.dates.length - 1];
  const bars = dataset.byDay.get(date);
  if (!bars) return;

  candleSeries.setData(bars.map((b) => ({ time: b.ts, open: b.o, high: b.h, low: b.l, close: b.c })));
  vwapSeries.setData(bars.map((b) => ({ time: b.ts, value: b.vwap })));
  volSeries.setData(bars.map((b) => ({ time: b.ts, value: b.v,
    color: b.c >= b.o ? "rgba(8,153,129,0.45)" : "rgba(242,54,69,0.45)" })));
  chart.timeScale().fitContent();

  let prof, profLabel;
  const w = period.startsWith("c") ? Number(period.slice(1)) : 0;
  if (w) {
    const idx = dataset.dates.indexOf(date);
    const win = dataset.dates.slice(Math.max(0, idx - w + 1), idx + 1);
    const all = win.flatMap((d) => dataset.byDay.get(d));
    prof = volumeProfile(all, cfg.profileBins, cfg.valueAreaPercent);
    profLabel = `直近${win.length}日`;
  } else {
    prof = volumeProfile(bars, cfg.profileBins, cfg.valueAreaPercent);
    profLabel = "当日";
  }
  currentProfile = prof;
  applyVisibility();

  const last = bars[bars.length - 1], first = bars[0];
  const chg = last.c - first.o, dev = ((last.c - last.vwap) / last.vwap) * 100;
  const cls = (x) => (x >= 0 ? "up" : "down"), sign = (x) => (x >= 0 ? "+" : "");
  $("meta").innerHTML = `
    <div class="stat"><span class="k">銘柄</span><span class="name"><span class="c">${curCode}</span>${curName}</span></div>
    <div class="stat"><span class="k">終値（${date}）</span><span class="v ${cls(chg)}">${fmtInt(last.c)} <span style="font-size:13px">${sign(chg)}${fmtInt(chg)}</span></span></div>
    <div class="stat"><span class="k">VWAP</span><span class="v vwap sub">${fmtInt(last.vwap)}</span></div>
    <div class="stat"><span class="k">VWAP乖離</span><span class="v sub ${cls(dev)}">${sign(dev)}${dev.toFixed(1)}%</span></div>
    <div class="stat"><span class="k">POC（${profLabel}）</span><span class="v poc sub">${fmtInt(prof.poc)}</span></div>
    <div class="stat"><span class="k">バリューエリア</span><span class="v sub">${fmtInt(prof.val)} 〜 ${fmtInt(prof.vah)}</span></div>`;
}

function buildPeriodControl() {
  const opts = [{ v: "day", label: "当日" }].concat((cfg.compositeWindows || []).map((w) => ({ v: `c${w}`, label: `直近${w}日` })));
  $("period").innerHTML = opts.map((o) =>
    `<button class="seg-btn${o.v === period ? " on" : ""}" data-v="${o.v}">${o.label}</button>`).join("");
}

// ===================================================================== events
const q = $("q");
const selLabel = () => (curCode ? `${curCode}  ${codeToName.get(curCode) || ""}` : "");
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
  const b = e.target.closest(".seg-btn"); if (!b) return;
  period = b.dataset.v;
  $("period").querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("on", x === b));
  render();
});
for (const btn of document.querySelectorAll(".toggle")) {
  btn.addEventListener("click", () => {
    const k = btn.dataset.key; show[k] = !show[k];
    btn.classList.toggle("on", show[k]); applyVisibility();
  });
}

initChart();
resizeOverlay();
boot().catch((e) => { $("meta").textContent = "読み込みに失敗しました: " + e; });
