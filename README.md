# 学習記録（PROGRIT Study Log）

[lexicon-pwa](https://github.com/Nietzsche-yokohama/lexicon-pwa) の「学習記録」タブを切り出した独立アプリ。
Slack に投稿される学習ログを Cloudflare Worker が集計し、静的ページで可視化する。

## 構成

- `public/index.html` — タブ切り替えシェル（週間面談／詳細）
- `public/progrit-weekly.html` — 学習ダッシュボード（KPI・グラフ・インサイト）
- `public/progrit.html` — 進捗（日次／週次）
- `worker/index.ts` — `/api/progrit` のみを提供する Cloudflare Worker（Slack から取得・KV にキャッシュ）
- `worker/progrit-seed.ts` — Slack の90日保持期限に備えた過去データの恒久シード

フロントは認証なし・ビルド不要（プレーンHTML）。バックエンドは元アプリの Worker から
`/api/progrit` エンドポイントだけを抜き出したもので、状態同期・AI解説などの機能は含まない。

## Cloudflare セットアップ（初回のみ）

```sh
npm ci

# KV namespace を作成し、出力された id / preview_id を wrangler.toml に反映
npx wrangler kv namespace create PROGRIT_KV
npx wrangler kv namespace create PROGRIT_KV --preview

# Worker をデプロイ
npm run worker:deploy

# Slack Bot Token を Worker Secret に設定
npx wrangler secret put SLACK_BOT_TOKEN

# Pages プロジェクトを作成してデプロイ
npm run pages:deploy
```

## GitHub Actions（`main` push で自動デプロイ）

以下を GitHub Secrets に登録する:

| 名前 | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Pages/Worker デプロイ用（Workers Scripts:Edit, Workers KV Storage:Edit, Cloudflare Pages:Edit） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウントID |
| `SLACK_BOT_TOKEN` | 学習記録チャンネル読み取り用 Slack Bot Token |

設定後は `main` への push で Pages・Worker が自動デプロイされる。
