# 旧 ingest 一式（kabulab-cf に吸収済み・実行禁止）

2026-09-11 にここへ退避した。**元の場所へ戻してはいけない。**

| 元の場所 | ファイル |
|---|---|
| `.github/workflows/` | `daily-ingest.yml`（平日 07:00 UTC）, `margin-ingest.yml`（火 08:00 UTC） |
| `scripts/` | `ingest-daily.ts`, `ingest-intra.ts`, `ingest-margin.ts` |
| `scripts/lib/` | `codes.ts`, `r2.ts` |

## 理由

これらは R2 バケット `vwap-data` の `daily/{code}.json` / `intra/{code}.json` /
`margin/{week}.json` / `margin/weeks.json` へ書き込む。**同じキーへは現在
kabulab-cf（リポジトリ `satoki252595/kabulab_tool_cloudflare`）の `vwap-ingest.yml` が
書いており、本リポジトリの分は git 未追跡だったため発火していなかった。**

`.github/workflows/` に置いたまま `git add` すると、その瞬間から同一キーへの
二重書込が始まる。退避先を `.github/workflows/` の外にしてあるのは、
GitHub Actions が拾えない場所へ物理的に移すためである。

`margin/` の 2026-06-12〜07-31 分は JPX が既に公開を終えており再取得できない。
事故で上書き・削除すると復元不能。

## 現在の正

- 取込: kabulab-cf の `vwap-ingest.yml`
- 配信: kabulab-cf Worker の `/vwap-analysis`

本リポジトリのフロント（`docs/`）と Worker コード（`worker/`）は参照用に残してある。
