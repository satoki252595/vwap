# 日本株 VWAP + 価格別出来高（5分足・全銘柄オンデマンド）

東証**全上場銘柄（約4,400）**を、4桁/英数字コードまたは銘柄名で検索し、
**閲覧した銘柄だけ**をその場で Yahoo Finance から取得して、VWAP と
価格別出来高（ボリュームプロファイル）を**ブラウザ内で計算・描画**します。
**データは一切保存しません**（＝容量が増え続ける問題が原理的に発生しない）。
ホスティングは GitHub Pages、取得中継だけ無料サーバーレスを使い、**ランニングコスト 0 円**。

```
GitHub Pages（docs/・静的）
   ├ stocks.json … 全上場銘柄マスター（検索用・週1自動再生成）
   └ 銘柄を選択 → 無料プロキシ経由で Yahoo 5分足(最大60日)を取得
                → ブラウザで VWAP / 価格別出来高 / 合成プロファイルを計算
                → lightweight-charts で描画
無料プロキシ（Val.town / Deno Deploy・0円）
   └ Yahoo chart API を CORS 付きで中継するだけ（保存なし・60秒キャッシュ）
```

ブラウザから Yahoo を直接叩けない（CORS）ため、**薄い中継プロキシ1つだけ**が必要です。
データは持たないので、プロキシは「通すだけ」の約60行です。

## ディレクトリ

```
proxy/yahoo.ts                 Yahoo 中継プロキシ（Val.town/Deno/ローカル共通）
docs/                          GitHub Pages 公開ルート
  index.html / app.js / style.css
  config.json                  ★ proxyBase（プロキシURL）・お気に入り等
  data/stocks.json             全上場銘柄マスター（検索用）
scripts/build_stocks.py        JPX→stocks.json 生成
.github/workflows/build-stocks.yml  週1でマスター再生成
flake.nix / .envrc             ローカル開発（python3+xlrd, deno）
```

## セットアップ

### 1. 中継プロキシをデプロイ（どちらか・0円）

**A. Val.town（GUIだけで完結・最短）**
1. https://val.town でサインイン → New → **HTTP val**。
2. `proxy/yahoo.ts` の内容を貼り付けて保存。
3. 発行された URL（例 `https://xxxx.web.val.run`）をコピー。

**B. Deno Deploy**
1. このリポジトリ（または `proxy/yahoo.ts`）を https://dash.deno.com で新規プロジェクトにデプロイ。
2. エントリポイントを `proxy/yahoo.ts` に指定。発行 URL をコピー。

### 2. フロントにプロキシURLを設定

`docs/config.json` の `proxyBase` にコピーしたURLを設定して commit/push：

```json
{ "proxyBase": "https://xxxx.web.val.run", "fetchRange": "60d",
  "compositeWindows": [5, 20, 60], "favorites": ["7203","6758","9984"] }
```

未設定のうちは画面に「プロキシ未設定」と表示されます。設定すれば全銘柄が見られます。

### 3. GitHub Pages（既に有効なら不要）

Settings → Pages → Source =「Deploy from a branch」、Branch=`main`/`/docs`。
公開URL: `https://<user>.github.io/<repo>/`

### 4. 銘柄マスターの自動更新

`build-stocks` ワークフローが週1（日曜朝）で JPX の最新一覧から `stocks.json` を再生成します。
初回は Actions → build-stocks → Run workflow で生成可（既に同梱済みなら不要）。

## 機能

- **全上場銘柄**（約4,400・英数字コード 130A 等含む）を、4桁/英数字コード or 銘柄名で
  部分一致検索（大小文字無視・前方一致優先）。検索ボックスはフォーカスで現在銘柄を自動クリア。
- 選択銘柄の **最大60営業日**の5分足を取得し、日付ドロップダウンで任意の日を表示。
- **VWAP**（寄り付きからの累積）ライン、**出来高**ヒストグラム（下部）。
- **価格別出来高**を価格軸に重ねて左側に表示（POC強調・バリューエリア網掛け）。
  集計期間を **当日 / 直近5・20・60日** で切替（複数日はブラウザ内で合成）。
- 各レイヤーは VWAP / 価格別出来高 / 出来高 のトグルで個別オンオフ。
- ライトクリーンUI・金額は整数表示。

## ローカル開発

```bash
nix develop                                   # python3+xlrd, deno 入り
python scripts/build_stocks.py                # 全銘柄マスター → docs/data/stocks.json
deno run -A proxy/yahoo.ts                     # プロキシ(http://localhost:8000)
# docs/config.json の proxyBase を "http://localhost:8000" にして
python -m http.server -d docs 8000 &           # ※ポートはプロキシと別に
#   → http://localhost:8000（配信）/ プロキシは8000以外で。例: 配信8200
```

## 仕様・注意

- **VWAP** = Σ(代表値×出来高)/Σ(出来高)、代表値=(高+安+終)/3、寄り付きから累積（日次リセット）。
- **価格別出来高**: 5分足からは正確な約定価格が不明なため、各バーの出来高を `[安値,高値]` へ
  均等配分してビンに積む OHLC ベースの近似。POC=最大出来高価格、VAH/VAL=総出来高の約70%が
  収まる価格帯。
- **データソース**: Yahoo は 5分足の遡及上限が約60日、かつIP単位のレート制限あり。プロキシは
  60秒の短期キャッシュ＋同意Cookieで緩和。万一プロキシのIPが弾かれる場合は別プロバイダへ。
- **コスト**: GitHub（Pages/Actions）も Val.town/Deno Deploy 無料枠も 0 円。データ保存なし。
