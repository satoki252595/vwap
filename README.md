# 日本株ボード（VWAP / 価格別出来高 / 日足10年 / 信用残高）

東証**全上場銘柄（約4,400）**を、4桁/英数字コードまたは銘柄名で検索し、3つのビューで表示する
**Cloudflare Worker + R2** アプリ。**ランニングコスト 0 円**。

| ビュー | 内容 | データ |
|---|---|---|
| **5分足VWAP** | ローソク足＋VWAP＋価格別出来高（POC/バリューエリア）＋出来高 | Yahoo 5分足を閲覧時に取得（オンデマンド・保存なし／60日上限） |
| **日足(長期)** | 10年分のローソク足＋出来高、1/3/5/全期間切替、分割・併合調整 | Yahoo日足を **R2に蓄積**（日次更新） |
| **信用残高** | 買残/売残/信用倍率/前週比のトレンド | JPX週次PDFを解析し **R2に蓄積**（週次更新） |

```
Cloudflare Worker（1つ・無料）
  ├ 静的フロント同居（docs/）
  ├ /api/chart  : 5分足を Yahoo から中継（同一オリジン＝CORS不要）
  ├ /api/daily  : R2の日足10年（分割調整済）を返す
  ├ /api/margin : R2の週次信用残高を返す
  ├ /api/admin/*: 手動バックフィル/取込（要トークン）
  └ Cron : 日次=日足更新 / 週次=JPX信用残高PDF取込 → R2
R2（無料10GB）: daily/<code>.json（日足10年）, margin/<week>.json（週次信用残高）
```
> なぜ D1 でなく R2 か：D1無料は「1日10万行書込」上限で、10年×全銘柄(約1,100万行)の
> バックフィルが不可能。R2は**銘柄ごと1ファイル＝書込が桁違いに少なく**、無料枠で完結。

## セットアップ（あなたの操作）

```bash
nix develop            # node + python(xlrd)
npm install            # unpdf + wrangler

# Cloudflare（無料アカウント）
npx wrangler login
npx wrangler r2 bucket create vwap-data
# wrangler.toml の ADMIN_TOKEN を推測されない値に変更

# 全銘柄マスター（検索用・未生成なら）
python scripts/build_stocks.py

# デプロイ（静的フロント＋API＋Cron が一括で上がる）
npx wrangler deploy
```

### 初回データ投入
- **信用残高**: `https://<worker>/api/admin/ingest-margin?token=<ADMIN_TOKEN>` を1回叩く（以降は週次Cron）。
- **日足バックフィル**: 全銘柄は `/api/admin/backfill-daily?token=...&n=30` を繰り返すか、優先銘柄を
  `/api/admin/backfill-one?code=7203&token=...` で即取得。以降は日次Cronが差分更新。
  - R2のカーソルで再開可能。無料枠の subrequest 上限に合わせ1回30銘柄ずつ処理。

## ローカル開発

```bash
npx wrangler dev       # http://localhost:8787（ローカルR2・miniflare）
# 例: 信用残高取込  curl "http://localhost:8787/api/admin/ingest-margin?token=change-me"
#     日足1銘柄      curl "http://localhost:8787/api/admin/backfill-one?code=7203&token=change-me"
```

## ディレクトリ

```
wrangler.toml          Worker設定（assets同居・R2・Cron）
worker/src/index.ts    ルーター＋Cron＋管理API
worker/src/yahoo.ts    5分足中継＋日足10年取得（分割/併合調整）
worker/src/margin.ts   JPX週次PDF取得＋解析（unpdf）
docs/                  フロント（index.html / app.js / style.css）+ data/stocks.json
scripts/build_stocks.py  JPX→全銘柄マスター生成
.github/workflows/build-stocks.yml  週1でマスター再生成
```

## 仕様メモ

- **VWAP** = Σ(代表値×出来高)/Σ(出来高)、代表値=(高+安+終)/3、寄り付きから累積。
- **価格別出来高**: 5分足の出来高を各バーの[安値,高値]へ均等配分する OHLC ベース近似。
- **分割・併合**: Yahooの split イベント＋調整後終値で日足を連続化（adj/c 係数でOHLC調整）。
- **データ取得の限界**: Yahoo 5分足は約60日が上限（10年は不可＝オンデマンド）。日足は10年遡及可。
  信用残高は JPX 週次PDF（直近〜、以降は週次蓄積）。
- **コスト**: Cloudflare Workers/R2 無料枠で完結（0円）。GitHub Pages は不要（Worker が静的も配信）。
