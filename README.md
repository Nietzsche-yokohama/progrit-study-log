# 学習記録（PROGRIT Study Log）

[lexicon-pwa](https://github.com/Nietzsche-yokohama/lexicon-pwa) の「学習記録」タブを切り出した独立アプリ。
Slack に投稿される学習ログを Cloudflare Worker が集計し、静的ページで可視化する。

## 構成

- `public/index.html` — タブ切り替えシェル（週間面談／詳細）
- `public/progrit.html` — 学習ダッシュボード（KPI・グラフ・インサイト）。index.html の「詳細」タブ
- `public/progrit-weekly.html` — 進捗（日次／週次）。index.html の「週間面談」タブ
- `public/dashboard.js` — 詳細／クール別3ページ共通の描画ロジック（科目一覧は Worker から受け取る）
- `worker/index.ts` — `/api/progrit` のみを提供する Cloudflare Worker（Slack から取得・KV にキャッシュ）。科目レジストリ `SUBJECTS` もここ
- `worker/index.test.ts` — パーサー・集計の回帰テスト（`npm test`）
- `worker/progrit-seed.ts` — 第一クール（Day1〜91）の確定データ。過去データの恒久シードであり、第一クールの正本

フロントは認証なし・ビルド不要（プレーンHTML）。バックエンドは元アプリの Worker から
`/api/progrit` エンドポイントだけを抜き出したもので、状態同期・AI解説などの機能は含まない。

## 科目の扱い（新しい科目は自動で組み込まれる）

過去に「Slackで新しい学習科目（リピーティング、オンライン英会話）が増えたのにパーサーが拾わず
集計から消えていた」「詳細タブと週間面談タブで累計時間が食い違っていた」という不具合が繰り返し
起きたため、**科目の一覧をコードに決め打ちしない**構造にしてある。

1. **科目レジストリは Worker の1か所だけ**（`worker/index.ts` の `SUBJECTS`）
   固定科目（キー・表示名・Slack上の表記パターン）はここにしか無い。`/api/progrit` は
   `summary.subjects`（クール別は `cycles[].subjects`）で科目一覧を返し、両フロント
   （`public/dashboard.js` / `public/progrit-weekly.html`）はそれを見て KPI・グラフ・凡例を
   描画する。フロントに科目名のリストは無い。
2. **未知の科目は自動検出して集計に入れる**（`findExtraEntries` → `ProgritDay.x`）
   投稿の中で固定科目のどれにも当てはまらない「科目名 N分」の行は、科目名を正規化
   （箇条書き記号・括弧書き・末尾の記号を除去）したうえで、その名前のまま科目として
   集計する。合計・グラフ・凡例に自動で載り、`summary.subjects` に `auto: true` で出てくる。
   **Slackに新しい科目を書き始めても、コードの変更は不要。**
   - 「合計 120分」「休憩 10分」のような学習項目でない行は `IGNORE_LABELS` で除外する。
     誤って科目登録された行があれば、ここに追記する。
   - 20文字を超える行（文章）は科目扱いしない（`MAX_AUTO_LABEL_LEN`）。
3. **新しく加わった科目はお知らせバナーで見える**（`summary.newSubjects`）
   直近14日以内に初登場した科目（固定・自動どちらも）は両フロントの青いバナーに
   「集計に組み込みました」と出る。自動検出は投稿の表記をそのまま科目名にするため、
   表記ゆれ（「音読」と「音読練習」が別科目になる等）や誤検出にここで気付ける。
4. **固定科目に昇格させたいとき**（任意）
   表記ゆれを1つにまとめたい・行の途中にあっても拾いたい・色を固定したいときだけ、
   `SUBJECTS` に1行足す（`pattern` は他と重ならない正規表現にする）。KVに自動検出科目として
   保存済みの分は、次回リクエスト時に `migrateLegacyDay` が固定科目へ付け替える（冪等）。
   色を好みにしたければ `dashboard.js` の `SUBJECT_COLORS` と `progrit-weekly.html` の
   `CAT_META` に任意で追記する（無ければ既定パレットから自動で割り当てる）。
5. **合計値の単一情報源化**（`summarize()`）
   全期間の合計分数・アクティブ日数は Worker が一度だけ計算し `summary.totalMinutes` として返す。
   両フロントページはこの値を表示に使い、ページ内で科目一覧から再計算した結果とは
   `Math.abs` で突き合わせて、ズレがあれば警告バナーを出す。

パーサーの挙動は `npm test`（`worker/index.test.ts`）で固定してある。科目の追加・正規化の
ルールを変えるときはここも更新する。

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
   `worker/index.ts` の `MANUAL_POSTS` に **Slack の本文をそのまま**書いて補完する（通常の
   パーサーで解釈するので科目が増えても書き方は変わらない。その日が KV に無いときだけ追加。
   再投稿すればそちらが勝つ）。Day139 はここで補完している。

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
