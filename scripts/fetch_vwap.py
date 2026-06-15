#!/usr/bin/env python3
"""
Yahoo Finance から日本株の5分足を取得し、VWAP と価格別出来高(ボリューム
プロファイル)を計算して docs/data/ 配下に JSON として保存する。

取得は yfinance を使用する。Yahoo は Cookie + crumb(同意フロー)と
IP単位のレート制限を課しており、これを手書きで保守し続けるのは脆い。
yfinance が同意/crumb 処理を内包しているため取得層をそこに委ねる。

出力はすべて冪等な「丸ごと上書き」。cron が遅延・スキップしても次回の
実行が同日分を取り直して埋め直す。取得失敗時は既存データを保持する。
"""

import json
import math
import os
import sys
import time
from datetime import datetime, timezone, timedelta

import yfinance as yf

JST = timezone(timedelta(hours=9))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "config", "tickers.json")
DATA_DIR = os.path.join(ROOT, "docs", "data")


# --------------------------------------------------------------------------
# 取得 (yfinance)
# --------------------------------------------------------------------------
def fetch_bars(symbol, period="60d", retries=3):
    """5分足を [{ts,o,h,l,c,v}] で返す(欠損・出来高0は除外)。
    period は Yahoo の 5分足上限(=60日)まで遡って一括取得する。"""
    last_err = None
    for attempt in range(retries):
        try:
            df = yf.Ticker(symbol).history(
                period=period, interval="5m", auto_adjust=False
            )
            if df is None or df.empty:
                raise RuntimeError("empty response")
            bars = []
            for ts, row in df.iterrows():
                o, h, l, c, v = (
                    row["Open"], row["High"], row["Low"], row["Close"], row["Volume"],
                )
                if any(x is None or (isinstance(x, float) and math.isnan(x))
                       for x in (o, h, l, c, v)) or v <= 0:
                    continue
                bars.append({
                    "ts": int(ts.timestamp()),
                    "o": float(o), "h": float(h), "l": float(l), "c": float(c),
                    "v": int(v),
                })
            return bars
        except Exception as e:  # noqa: BLE001  429/一時障害はバックオフ再試行
            last_err = e
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"fetch failed for {symbol}: {last_err}")


# --------------------------------------------------------------------------
# VWAP(寄り付きからの累積)
# --------------------------------------------------------------------------
def add_vwap(bars):
    cum_pv = cum_v = 0.0
    for b in bars:
        tp = (b["h"] + b["l"] + b["c"]) / 3.0
        cum_pv += tp * b["v"]
        cum_v += b["v"]
        b["vwap"] = round(cum_pv / cum_v, 2) if cum_v else round(b["c"], 2)
        for k in ("o", "h", "l", "c"):
            b[k] = round(b[k], 2)
    return bars


# --------------------------------------------------------------------------
# 価格別出来高(ボリュームプロファイル)
# 5分足からは正確な約定価格が不明なため、各バーの出来高を [安値,高値] に
# 均等配分してビンへ積む(OHLCベースの標準的近似)。
# --------------------------------------------------------------------------
def volume_profile(bars, nbins=50, va_pct=0.70):
    if not bars:
        return None
    lo = min(b["l"] for b in bars)
    hi = max(b["h"] for b in bars)
    if hi <= lo:
        hi = lo + 1.0
    bin_size = (hi - lo) / nbins
    vols = [0.0] * nbins

    for b in bars:
        span = b["h"] - b["l"]
        if span <= 0:
            idx = min(int((b["l"] - lo) / bin_size), nbins - 1)
            vols[idx] += b["v"]
            continue
        first = max(0, int((b["l"] - lo) / bin_size))
        last = min(nbins - 1, int((b["h"] - lo) / bin_size))
        for i in range(first, last + 1):
            bin_lo = lo + i * bin_size
            bin_hi = bin_lo + bin_size
            overlap = min(b["h"], bin_hi) - max(b["l"], bin_lo)
            if overlap > 0:
                vols[i] += b["v"] * (overlap / span)

    centers = [round(lo + (i + 0.5) * bin_size, 2) for i in range(nbins)]
    bins = [{"price": centers[i], "volume": int(vols[i])} for i in range(nbins)]

    poc_idx = max(range(nbins), key=lambda i: vols[i])
    total = sum(vols)

    # バリューエリア: POC から上下の大きい方を取り込みながら va_pct まで拡張
    lo_i = hi_i = poc_idx
    acc = vols[poc_idx]
    target = total * va_pct
    while acc < target and (lo_i > 0 or hi_i < nbins - 1):
        below = vols[lo_i - 1] if lo_i > 0 else -1
        above = vols[hi_i + 1] if hi_i < nbins - 1 else -1
        if above >= below:
            hi_i += 1
            acc += vols[hi_i]
        else:
            lo_i -= 1
            acc += vols[lo_i]

    return {
        "binSize": round(bin_size, 4),
        "priceLow": round(lo, 2),
        "priceHigh": round(hi, 2),
        "bins": bins,
        "poc": centers[poc_idx],
        "vah": centers[hi_i],
        "val": centers[lo_i],
        "totalVolume": int(total),
    }


# --------------------------------------------------------------------------
# 保存ユーティリティ
# --------------------------------------------------------------------------
def day_of(bars):
    return datetime.fromtimestamp(bars[0]["ts"], JST).date().isoformat()


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def list_day_files(symbol_dir):
    """その銘柄の保存済み日付(YYYY-MM-DD)を昇順で返す。composite_*.json は除外。"""
    if not os.path.isdir(symbol_dir):
        return []
    out = []
    for n in os.listdir(symbol_dir):
        if n.endswith(".json") and not n.startswith("composite"):
            out.append(n[:-5])
    return sorted(out)


def build_composite(symbol_dir, days, nbins, va_pct):
    """直近 N 日分の per-day ファイルからバーを集めて合成プロファイルを作る。"""
    dates = list_day_files(symbol_dir)[-days:]
    all_bars = []
    for d in dates:
        try:
            with open(os.path.join(symbol_dir, f"{d}.json"), encoding="utf-8") as f:
                all_bars.extend(json.load(f).get("bars", []))
        except (OSError, ValueError):
            continue
    if not all_bars:
        return None, dates
    return volume_profile(all_bars, nbins=nbins, va_pct=va_pct), dates


# --------------------------------------------------------------------------
# Notion(任意・ベストエフォート)
#   NOTION_TOKEN と NOTION_DATABASE_ID があれば当日サマリを upsert。
#   DB に必要なプロパティ(README参照): 銘柄(title), 終値/VWAP/乖離率/POC(number),
#   更新(date)。失敗してもデータパイプラインは止めない。
# --------------------------------------------------------------------------
def notion_upsert(name, symbol, date, close, vwap, poc):
    token = os.environ.get("NOTION_TOKEN")
    db = os.environ.get("NOTION_DATABASE_ID")
    if not token or not db:
        return
    import urllib.request
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }
    title = f"{name} {symbol} {date}"
    dev = round((close - vwap) / vwap * 100, 2) if vwap else 0.0
    props = {
        "銘柄": {"title": [{"text": {"content": title}}]},
        "終値": {"number": close},
        "VWAP": {"number": vwap},
        "乖離率": {"number": dev},
        "POC": {"number": poc},
        "更新": {"date": {"start": datetime.now(JST).isoformat()}},
    }
    try:
        q = json.dumps(
            {"filter": {"property": "銘柄", "title": {"equals": title}}}
        ).encode()
        req = urllib.request.Request(
            f"https://api.notion.com/v1/databases/{db}/query",
            data=q, headers=headers, method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            hits = json.load(r).get("results", [])
        if hits:
            req = urllib.request.Request(
                f"https://api.notion.com/v1/pages/{hits[0]['id']}",
                data=json.dumps({"properties": props}).encode(),
                headers=headers, method="PATCH",
            )
        else:
            req = urllib.request.Request(
                "https://api.notion.com/v1/pages",
                data=json.dumps(
                    {"parent": {"database_id": db}, "properties": props}
                ).encode(),
                headers=headers, method="POST",
            )
        urllib.request.urlopen(req, timeout=30).read()
    except Exception as e:  # noqa: BLE001  ベストエフォート
        print(f"  [notion] skip ({symbol}): {e}", file=sys.stderr)


def group_by_day(bars):
    """5分足を JST 日付ごとに分割。{date: [bars...]} を昇順で返す。"""
    groups = {}
    for b in bars:
        d = datetime.fromtimestamp(b["ts"], JST).date().isoformat()
        groups.setdefault(d, []).append(b)
    return dict(sorted(groups.items()))


def ticker_entry(symbol, name, symbol_dir, windows):
    days = list_day_files(symbol_dir)
    comps = [w for w in windows
             if os.path.exists(os.path.join(symbol_dir, f"composite_{w}.json"))]
    return {"symbol": symbol, "name": name, "days": days, "composites": comps}


# --------------------------------------------------------------------------
def main():
    with open(CONFIG, encoding="utf-8") as f:
        cfg = json.load(f)
    nbins = cfg.get("profileBins", 50)
    va_pct = cfg.get("valueAreaPercent", 0.70)
    windows = cfg.get("compositeWindows", [20, 60])
    period = cfg.get("fetchPeriod", "60d")
    tickers = cfg["tickers"]

    index = {"updated": datetime.now(JST).isoformat(),
             "composites": windows, "tickers": []}

    for i, t in enumerate(tickers):
        symbol, name = t["symbol"], t["name"]
        symbol_dir = os.path.join(DATA_DIR, symbol)
        if i:
            time.sleep(1.5)  # レート制限緩和のため間隔を空ける
        try:
            bars = fetch_bars(symbol, period=period)
            if not bars:
                print(f"  {symbol}: no bars (休場日?) — 既存データ保持", file=sys.stderr)
                index["tickers"].append(ticker_entry(symbol, name, symbol_dir, windows))
                continue

            # 60日分を JST 日付ごとに分割し、各日で VWAP(日次リセット)+プロファイルを保存
            by_day = group_by_day(bars)
            for date, day_bars in by_day.items():
                add_vwap(day_bars)
                prof = volume_profile(day_bars, nbins=nbins, va_pct=va_pct)
                write_json(
                    os.path.join(symbol_dir, f"{date}.json"),
                    {"symbol": symbol, "name": name, "date": date,
                     "bars": day_bars, "profile": prof},
                )

            # 集計期間ごとの合成プロファイル(直近N営業日)
            for w in windows:
                comp_prof, comp_dates = build_composite(symbol_dir, w, nbins, va_pct)
                if comp_prof:
                    write_json(
                        os.path.join(symbol_dir, f"composite_{w}.json"),
                        {"symbol": symbol, "name": name, "window": w, "days": comp_dates,
                         "from": comp_dates[0], "to": comp_dates[-1], "profile": comp_prof},
                    )

            index["tickers"].append(ticker_entry(symbol, name, symbol_dir, windows))

            last_date = max(by_day)
            last = by_day[last_date][-1]
            last_prof = volume_profile(by_day[last_date], nbins=nbins, va_pct=va_pct)
            notion_upsert(name, symbol, last_date, last["c"], last["vwap"], last_prof["poc"])
            print(f"  {symbol}: {len(by_day)}日 / {len(bars)}本, "
                  f"最新{last_date} VWAP={last['vwap']} POC={last_prof['poc']}")
        except Exception as e:  # noqa: BLE001
            print(f"  {symbol}: ERROR {e}", file=sys.stderr)
            if list_day_files(symbol_dir):  # 失敗時も既存データは index に残す
                index["tickers"].append(ticker_entry(symbol, name, symbol_dir, windows))

    write_json(os.path.join(DATA_DIR, "index.json"), index)
    print(f"index.json updated: {len(index['tickers'])} tickers, windows={windows}")


if __name__ == "__main__":
    main()
