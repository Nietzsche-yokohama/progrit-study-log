# 学習記録（PROGRIT Study Log）

[lexicon-pwa](https://github.com/Nietzsche-yokohama/lexicon-pwa) の「学習記録」タブを切り出した独立アプリ。
Slack に投稿される学習ログを Cloudflare Worker が集計し、静的ページで可視化する。

## 構成

- `public/index.html` — タブ切り替えシェル（週間面談／詳細）
- `public/progrit.html` — 学習ダッシュボード（KPI・グラフ・インサイト）。index.html の「詳細」タブ
- `public/progrit-weekly.html` — 進捗（日次／週次）。index.html の「週間面談」タブ
- `worker/index.ts` — `/api/progrit` のみを提供する Cloudflare Worker（Slack から取得・KV にキャッシュ）
- `worker/progrit-seed.ts` — 第一クール（Day1〜91）の確定データ。過去データの恒久シードであり、第一クールの正本

フロントは認証なし・ビルド不要（プレーンHTML）。バックエンドは元アプリの Worker から
`/api/progrit` エンドポイントだけを抜き出したもので、状態同期・AI解説などの機能は含まない。

## 再発防止策（未知科目の見落とし／画面間の合計不一致）

過去に「Slackで新しい学習科目（リピーティング）が増えたのにパーサーが拾わず集計から消えていた」
「詳細タブと週間面談タブで累計時間が食い違っていた（週次タブに`PROGRAM_WEEKS`の決め打ち上限があり
実績週数を超えた分が欠落していた）」という2つの不具合があったため、以下を組み込んでいる。

1. **未知科目の自動検知**（`worker/index.ts` の `findUnknownEntries` / `KNOWN_SUBJECTS`）
   Slackメッセージ内で「科目名 N分」の形式に見える行のうち、`KNOWN_SUBJECTS` のどれにも
   一致しないものを `unknown` として日ごとに保持する。`/api/progrit` のレスポンスの
   `summary.unknownSubjects` に集計され、該当があれば両フロントページに警告バナーが自動表示される。
   → 新しい科目が増えたら `KNOWN_SUBJECTS` とパーサー（`sumMin` 呼び出し）、両フロントの
   科目リスト・グラフに追記すること。追記を忘れてもバナーで気付ける。
2. **合計値の単一情報源化**（`worker/index.ts` の `summarize()`）
   全期間の合計分数・アクティブ日数は Worker が一度だけ計算し `summary.totalMinutes` として返す。
   両フロントページはこの値を表示に使い、ページ内で独自に合計を再計算した結果とは
   `Math.abs` で突き合わせて、ズレがあれば警告バナーを出す。週次タブ側の集計ロジック
   （`PROGRAM_WEEKS` 上限など）にバグがあっても、表示される「累計」の数字自体は
   常にサーバー側の値と一致する。

## 日番号のルール（第二クール以降は「クール内のN日目」で投稿する）

Slack の投稿は `プログリットで学習N日目` の N を **そのクール内の日数** で書く。
第一クールから通算した番号に毎回手で書き直す運用（「48日目」→「139日目」）は廃止した。

- 第一クール: Day1〜91（2026-04-24〜07-23）。終了済みで、今後いっさい変更しない。
- 第二クール: 通算 Day92〜。投稿の「N日目」は通算 `N + 91` として集計される
  （例: 「50日目」→ Day141）。従来どおり通算で「141日目」と書いても同じ結果になる。

仕組みは `worker/index.ts` の `resolveAbsoluteDay`。投稿の「N日目」に対して各クールの
開始日を基点にした候補（N、N+91、…）を作り、**投稿日時にいちばん近い実日付になる候補**を
採る。候補同士は91日以上離れているので、数日〜数週間の後追い・まとめ投稿でも取り違えない。
第三クールが始まったら `CYCLE_START_DAYS` に開始 Day を追加し、`buildCycles` にタブ定義を足す。

### 第一クールはシードで固定（Slack から上書きされない）

2026-09-10 に第二クールの投稿を誤って「48日目」と書いたことで、KV 上の第一クール Day48 が
第二クールの内容で上書きされる事故があった（元の投稿は Slack の90日保持で消えており、
旧 lexicon-worker の KV に残っていた 8/11 時点のコピーから復元した）。再発防止として:

1. `worker/progrit-seed.ts` を第一クール全体（Day1〜91）に拡張し、これを正本にした。
2. Worker はリクエストごとに Day1〜91 をシードの値で上書きし直す（`applyLockedSeed`、冪等）。
   Slack の差分取得でも Day1〜91 は決して更新しない（`CYCLE_BOUNDARY_DAY`）。
   第一クールの数字を直したいときは KV ではなくシードを直す。
3. Slack 上でメッセージを編集しても ts が変わらず差分取得に乗らないため、編集で直した投稿は
   `worker/index.ts` の `MANUAL_DAYS` で補完する（その日が KV に無いときだけ追加。再投稿すれば
   そちらが勝つ）。Day139 はここで補完している。

## アクセストークン（`APP_TOKEN`）

Worker は `Authorization: Bearer <APP_TOKEN>` を要求する。フロント側の受け渡しは
`public/auth.js` に集約してあり、次の3点で「スマホで開けない」状態を防いでいる。

1. **リンクで渡せる** — `https://progrit-study-log.pages.dev/#token=<APP_TOKEN>` を開くと
   トークンを localStorage に保存し、URLからは即座に消す。スマホで長い文字列を
   手打ちする必要がない。ホーム画面に追加するのはトークンを消した後のURLでよい。
2. **通らなかったトークンは保存しない** — 401 のときは保存済みトークンを破棄してから
   入力欄を出す。誤入力が localStorage に焼き付いて毎回 401 になるのを防ぐ。
   （旧実装は `window.prompt` の入力を検証前に保存しており、一度間違えると
   `HTTP 401` の画面から復帰できなくなっていた）
3. **入力欄は画面内に出す** — `window.prompt` は iframe 内で扱いにくく、貼り付けもしづらい。

### 入れ替え手順（値は読み出せないので、紛失したら再発行するしかない）

**正本は GitHub Secrets の `APP_TOKEN`**。`.github/workflows/deploy.yml` が push のたびに
`wrangler secret put APP_TOKEN` で Cloudflare 側へ焼き直すため、**Cloudflare だけ変えても
次の push で元に戻る**。必ず GitHub 側から入れ替えること。

```sh
gh secret set APP_TOKEN --repo Nietzsche-yokohama/progrit-study-log --body '<新しいトークン>'
gh run rerun <最新のrun id> --repo Nietzsche-yokohama/progrit-study-log   # Cloudflare側へ反映
```

急ぎで Cloudflare 側だけ直す場合は次（ただし上記の理由で一時的）。

```sh
npx wrangler secret put APP_TOKEN --name progrit-study-log-worker
```

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
