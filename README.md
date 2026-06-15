# 日本株 VWAP + 価格別出来高（5分足）

Yahoo Finance の5分足を **GitHub Actions（15分間隔）** で取得し、VWAP と
価格別出来高（ボリュームプロファイル）を計算して **リポジトリに JSON 保存**、
**GitHub Pages** の静的サイト（TradingView lightweight-charts）で表示します。
任意で **Notion** に当日サマリを併記します。**ランニングコスト 0 円**。

```
GitHub Actions (cron 15分) ─ yfinance で 5分足取得
   ├ VWAP（寄り付きからの累積）を各バーへ付与
   └ 価格別出来高（当日 / 直近N日合成）と POC・VAH・VAL を計算
   ▼ docs/data/<銘柄>/<日付>.json を commit（+ 任意で Notion へ upsert）
GitHub Pages（docs/） ライトクリーンUI・整数表示
   ├ ローソク足 + VWAP ライン + 出来高（下部）
   ├ 価格別出来高を価格軸に重ねて左側に水平表示（POC強調・バリューエリア網掛け）
   └ 全上場銘柄(約4,000)を検索（4桁コード / 銘柄名の一部一致）。
     チャート実体は監視リスト(config)の収集済み銘柄。未収集は案内表示。
```

検索用の全銘柄マスター（`docs/data/stocks.json`）は JPX 公式の
「東証上場銘柄一覧(data_j.xls)」から生成します（週1で自動再生成）。
表示・トグル(VWAP/価格別出来高/出来高)・期間(当日/複数日合成)はすべて
クライアントサイドで完結します。

## ディレクトリ

```
config/tickers.json            監視銘柄(=チャート収集対象)・パラメータ
scripts/fetch_vwap.py          取得・VWAP・プロファイル計算・保存
scripts/build_stocks.py        JPX→全銘柄マスター(stocks.json)生成
.github/workflows/fetch.yml    15分間隔の5分足収集
.github/workflows/build-stocks.yml  週1の全銘柄マスター再生成
docs/                          GitHub Pages 公開ルート
  index.html / app.js / style.css
  data/                        生成データ（Actions が commit）
    stocks.json                検索用 全上場銘柄マスター
    <銘柄>/<日付>.json          5分足+VWAP+プロファイル
flake.nix / .envrc             ローカル開発（nix devShell: yfinance+xlrd）
```

## セットアップ

1. **リポジトリ作成・push**（public 推奨：Actions 実行時間が無制限・0円）
   ```bash
   git init && git add -A && git commit -m "init"
   gh repo create <name> --public --source=. --push
   ```
2. **GitHub Pages を有効化**: Settings → Pages → Source =「Deploy from a branch」、
   Branch = `main` / フォルダ = `/docs`。
   公開URL: `https://<user>.github.io/<repo>/`
3. **Actions の書き込み権限**: Settings → Actions → General →
   Workflow permissions =「Read and write permissions」。
4. （任意）**Notion 併用**: Settings → Secrets and variables → Actions に
   `NOTION_TOKEN` と `NOTION_DATABASE_ID` を登録。未設定なら Notion 連携はスキップ。
5. 初回は Actions タブ →「build-stocks」→ Run workflow で全銘柄マスターを生成し、
   続けて「fetch-vwap」→ Run workflow で監視リストの5分足を収集して動作確認。

> cron は UTC 基準で「JST 9:00–15:30 の立会時間に15分間隔」。GitHub の cron は
> 遅延・スキップが起き得ますが、毎回その日の全5分足を取り直して**丸ごと上書き**
> するため、1回飛んでも次回が埋め直します。

## 銘柄の追加・変更（チャート収集対象）

検索は全上場銘柄が対象ですが、**チャート表示は `config/tickers.json` の監視リスト
銘柄のみ**です（未収集銘柄を選ぶと追加方法を案内）。表示したい銘柄を
`{ "symbol": "7203.T", "name": "トヨタ自動車" }` 形式で追加してください
（コードは `7203.T` 形式）。`compositeDays`（合成日数）, `profileBins`（ビン数≒
粒度）, `valueAreaPercent` も調整可。銘柄を増やすほど Actions 実行時間と Yahoo
レート制限の負荷が上がるので、間隔・銘柄数は控えめに。

## Notion データベースの必要プロパティ

`NOTION_DATABASE_ID` の DB に以下のプロパティを用意してください（名称一致が必要）:

| プロパティ | 型 |
|---|---|
| 銘柄 | タイトル |
| 終値 | 数値 |
| VWAP | 数値 |
| 乖離率 | 数値 |
| POC | 数値 |
| 更新 | 日付 |

Integration を作成し、対象DBに「接続」しておくこと。プロパティ不一致時は
連携のみスキップし、データ収集と Pages 表示は継続します。

## ローカル開発（nix）

```bash
nix develop                              # yfinance + xlrd 入り devShell
python scripts/build_stocks.py           # 全銘柄マスター → docs/data/stocks.json
python scripts/fetch_vwap.py             # 5分足取得 → docs/data へ出力
python -m http.server -d docs 8000       # → http://localhost:8000
```

## 仕様メモ

- **VWAP** = Σ(代表値×出来高)/Σ(出来高)、代表値=(高+安+終)/3、寄り付きから累積（日次リセット）。
- **価格別出来高**: 5分足からは正確な約定価格が不明なため、各バーの出来高を
  `[安値, 高値]` に均等配分してビンへ積む OHLC ベースの近似。
  **POC** = 最大出来高価格、**バリューエリア(VAH/VAL)** = POC から拡張して
  総出来高の約70%が収まる価格帯。
- **データソースの注意**: Yahoo は IP 単位のレート制限があり、稀に取得失敗
  （429）が起こります。失敗時は既存データを保持して次回に再取得します。
  多数の銘柄を短間隔で取得すると弾かれやすいので、銘柄数や間隔は控えめに。
```
