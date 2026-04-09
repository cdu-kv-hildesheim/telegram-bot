# telegram-bot

A Cloudflare Worker that lets you manage static-site content from Telegram. You send a voice note, a photo or a few lines of text to a Telegram bot, Claude Code drafts the changes in a GitHub pull request, you review a live preview, and one tap publishes it.

One worker can serve **multiple bots** for multiple sites — they're distinguished by the webhook path `/webhook/{siteId}`.

## What you get

- **Telegram → GitHub issue** for every task, automatically labelled with `telegram` + `site:{id}`.
- **Forum topics in private chat**: each task lives in its own thread so the main chat stays clean. `/new_task THEMA` creates the thread, further messages in that thread become comments on the same issue.
- **Voice transcription** via OpenAI Whisper (`gpt-4o-mini-transcribe`).
- **Photos, audio files and documents** are uploaded to Telegram and linked in the issue body.
- **Media groups** (multiple photos sent at once) are buffered in KV and processed as a single task.
- **PDF / DOCX conversion** to Markdown happens in the GitHub Actions workflow via [markitdown](https://github.com/microsoft/markitdown) so Claude can read the contents.
- **Claude Code Action v1** runs in GitHub Actions, writes the content files, opens a pull request, deploys a preview, and sends back a link to Telegram.
- **Site-scoped authorization**: a user authorized on bot A is not automatically allowed on bot B.
- **Inline buttons** to execute, reply, cancel, merge or discard — so the whole workflow can be driven from the Telegram chat.

## Architecture

```
┌──────────┐   webhook    ┌────────────────────┐  repository_  ┌───────────────┐
│ Telegram │────────────▶ │ Cloudflare Worker  │─  dispatch  ─▶│ GitHub Action │
│   bot    │  /webhook/X  │  (this repo)       │               │  (your repo)  │
└──────────┘              │                    │               │               │
      ▲                   │ - auth / KV        │               │ - Claude Code │
      │                   │ - creates issue    │               │ - biome/tests │
      │                   │ - forum topic mgmt │               │ - preview     │
      │       callback    │                    │   callback    │ - opens PR    │
      └────────────────── │                    │◀──────────────│               │
                          └────────────────────┘               └───────────────┘
                                   ▲
                                   │ webhook
                                   ▼
                          ┌────────────────┐
                          │  GitHub App    │
                          │  (issue/PR     │
                          │   events)      │
                          └────────────────┘
```

Three pieces:

1. **This repo** → Cloudflare Worker that takes Telegram webhooks, creates GitHub issues, and dispatches a workflow when a task should be executed.
2. **A GitHub App** → lets the worker sign commits / open PRs / post comments as a bot identity. Webhook points back to the worker for issue-comment and PR events.
3. **Your content repo** → contains the Astro/Next/whatever site **and** the `telegram-claude.yml` workflow (see `examples/workflow.example.yml`) that runs Claude Code to actually edit files.

## What lives where

```
telegram-bot/                   ← this repo
├── src/
│   ├── config.ts               ← 👉 EDIT: SITES, ADMIN_ID, GITHUB_REPO
│   ├── index.ts                ← Worker entry + handlers
│   ├── types.ts                ← Types + pure helpers
│   ├── telegram.ts             ← grammY wrapper
│   ├── github.ts               ← GitHub App auth + API
│   ├── openai.ts               ← Whisper transcription
│   ├── types.test.ts           ← Pure-helper tests (44+)
│   └── github.test.ts          ← Chat-id marker tests
├── examples/
│   ├── bot.example.json        ← Per-site bot config template
│   └── workflow.example.yml    ← GitHub Actions workflow (copy into content repo)
├── setup.sh                    ← Register webhook + description at Telegram
├── wrangler.toml               ← Cloudflare Worker config
├── biome.json
├── package.json
└── README.md                   ← this file
```

## Setting up from scratch

Rough time: 20–30 minutes once you've done it once. The first time, expect 1–2 hours because you'll be poking around unfamiliar settings pages.

### 1. Clone this repo and install

```bash
git clone https://github.com/cdu-nordstemmen/telegram-bot
cd telegram-bot
npm install
```

### 2. Edit `src/config.ts`

Three things to fill in:

```ts
export const ADMIN_ID = 13627541;          // Your Telegram user ID
export const GITHUB_REPO = "acme/website"; // Content repo (owner/name)

export const SITES = {
  main: {
    id: "main",
    name: "Acme Website",
    domain: "acme.com",
    workspace: "website",          // npm workspace name, used by the workflow
    contentDir: "src/content",     // path inside the repo the bot may edit
    botUsername: "acme-telegram-bot[bot]",
    tokenKey: "TELEGRAM_TOKEN",    // env var that holds this bot's token
  },
  // Add more entries for additional sites / bots.
};
```

### 3. Create one (or more) Telegram bot(s)

In Telegram, open [@BotFather](https://t.me/BotFather):

- `/newbot` → pick a name (e.g. `Acme Content`) and a username (`acme_content_bot`). Save the **HTTP API token**.
- `/mybots` → select your bot → **Bot Settings**:
  - **Topics in Private Chats** → Enable (required for threading).
  - **Manage Topics** → **Restricted** (don't let users create topics themselves — only the bot via `/new_task`).

If you want separate bots for separate sites, repeat per site.

### 4. Create a GitHub App

Owner: the org / user that owns the content repo. Suggested settings:

- **Webhook URL**: leave empty for now — we set it after the worker is deployed.
- **Webhook secret**: generate something random, save it; this becomes `WEBHOOK_SECRET`.
- **Repository permissions**: Contents: Read/Write, Issues: Read/Write, Pull Requests: Read/Write, Metadata: Read.
- **Subscribe to events**: Issue comment, Pull request.

After creating the app:
- Download the **private key** (a `.pem` file). You'll paste it as `GITHUB_APP_PRIVATE_KEY` in Cloudflare.
- Note the **App ID** (numeric) → becomes `GITHUB_APP_ID`.
- **Install** the app on your content repo. From the install URL, grab the **installation ID** (the numeric segment of the URL) → becomes `GITHUB_APP_INSTALLATION_ID`.
- The app gets a login like `acme-telegram-bot[bot]` → put that into `SiteConfig.botUsername`.

### 5. Create the KV namespace and deploy the Worker

```bash
npx wrangler kv namespace create USERS
# paste the returned id into wrangler.toml, or configure it in the dashboard
npx wrangler deploy
```

Set up a **custom domain** for the worker (e.g. `telegram.acme.com`) in the Cloudflare dashboard under your worker → Settings → Triggers → Custom Domains. This is the base URL for webhooks and callbacks.

### 6. Set the Worker secrets + vars

In the Cloudflare dashboard on the worker you just deployed:

| Name                         | Type     | Value                                                             |
|------------------------------|----------|-------------------------------------------------------------------|
| `GITHUB_APP_ID`              | Variable | numeric app id                                                    |
| `GITHUB_APP_INSTALLATION_ID` | Variable | numeric installation id                                           |
| `GITHUB_APP_PRIVATE_KEY`     | Secret   | contents of the `.pem` file                                       |
| `WEBHOOK_SECRET`             | Secret   | the value you chose in step 4 (shared across bots + GH webhook)   |
| `OPENAI_API_KEY`             | Secret   | from platform.openai.com                                          |
| `TELEGRAM_TOKEN`             | Secret   | bot token for the first site (name matches `SITES[0].tokenKey`)   |
| `TELEGRAM_TOKEN_OTHER`       | Secret   | bot token for the second site (name matches its `tokenKey`)       |

You don't need to add them to `wrangler.toml` — set them once in the dashboard.

### 7. Wire up the GitHub App webhook

Go back to your GitHub App settings:

- **Webhook URL**: `https://telegram.acme.com/github`
- **Webhook secret**: same `WEBHOOK_SECRET` as in step 6
- Events: Issue comment, Pull request

### 8. Register the Telegram webhooks

Copy `examples/bot.example.json` to `bot-{siteId}.json` per site (e.g. `bot-main.json`) and edit the `webhook_url`, `description` and `short_description`.

Create a `.env` next to `setup.sh`:

```dotenv
WEBHOOK_SECRET=the-same-secret-as-the-worker
TELEGRAM_TOKEN_MAIN=1234567:abc...
TELEGRAM_TOKEN_OTHER=7654321:xyz...
```

Then:

```bash
./setup.sh --site main
./setup.sh --site other
```

The script calls the Telegram Bot API to set the webhook URL, description, short description and command list. Re-run it whenever you change `bot-{siteId}.json`.

### 9. Install the workflow in your content repo

Copy `examples/workflow.example.yml` to `.github/workflows/telegram-claude.yml` **inside your content repo**, not this one. Edit:

- `BOT_USERNAME` mapping
- `CALLBACK_URL` base (`https://telegram.acme.com/callback/...`)
- `CLAUDE_CODE_OAUTH_TOKEN` secret: set in the content repo's Actions secrets (use `anthropics/claude-code-action@v1` — see [docs](https://code.claude.com/docs/en/github-actions)).
- The `site_workspace` build commands (e.g. `npm -w website run build`).
- Cloudflare preview deployment secrets if you want live previews.

### 10. Try it

In Telegram, open your bot:

1. `/start` → should welcome you by name (your ID matches `ADMIN_ID`).
2. `/new_task Test task` → bot opens a new thread called "Test task".
3. In the thread: type "test", send it. The bot creates a GitHub issue, Claude plans it, you get the plan as a reply with inline buttons. Tap **Umsetzen** to run the full workflow.

## How it works

### Request routing

The worker accepts:

- `POST /webhook/{siteId}` — Telegram updates for bot `siteId`. The `X-Telegram-Bot-Api-Secret-Token` header is verified against `WEBHOOK_SECRET`.
- `POST /github` — GitHub App webhook. HMAC-SHA256 signature verified against `WEBHOOK_SECRET`. Site is determined from the issue's `site:{id}` label.
- `POST /callback/{siteId}` — Workflow callback from the Claude Code job. `Authorization: Bearer {WEBHOOK_SECRET}`.
- `GET /health` — returns 503 if required env vars are missing.

### Per-task lifecycle

1. User types `/new_task Stammtisch am 25.4.` in the bot's main chat.
2. Bot creates a forum topic "Stammtisch am 25.4." and stores a pending flag in KV (`pending-task:{siteId}:{chatId}:{threadId}`, TTL 1 h).
3. User sends content in the thread (text / voice / photo / document / multiple photos as a media group).
4. Bot creates a GitHub issue with labels `telegram` + `site:{id}`, renames the thread to `#N Stammtisch am 25.4.`, stores the thread↔issue mapping in KV, and dispatches `telegram-plan`.
5. GitHub Action → Claude reads the issue + any converted documents, posts a plan as a comment.
6. The GitHub App webhook fires; the worker relays the comment into the thread with Umsetzen / Antworten / Abbrechen buttons.
7. User taps Umsetzen → worker dispatches `telegram-execute`.
8. Workflow runs Claude Code Action v1 against the content repo, runs `biome check --write`, commits, pushes, opens a PR, deploys a preview, calls the worker callback.
9. Worker posts "Auftrag ist bereit" with Freigeben / Ändern / Verwerfen buttons.
10. Freigeben → worker merges the PR; a deploy from main publishes the change.

### Data in KV

| Key                                             | Value               |
|-------------------------------------------------|---------------------|
| `user:{siteId}:{userId}`                        | `first_name`        |
| `pending:{siteId}:{userId}`                     | `first_name` (24 h) |
| `pending-task:{siteId}:{chatId}:{threadId}`     | `thema` (1 h)       |
| `topic:{siteId}:{chatId}:{issueNumber}`         | `threadId`          |
| `thread:{siteId}:{chatId}:{threadId}`           | `issueNumber`       |
| `pr:{siteId}:{chatId}:{prNumber}`               | `threadId`          |
| `mediagroup:{siteId}:{threadId}:{mediaGroupId}` | `[message, ...]`    |

## Bot commands

| Command            | Who   | Does                                          |
|--------------------|-------|-----------------------------------------------|
| `/start`           | all   | Welcome + your user id                        |
| `/join`            | new   | Sends a join request to the admin             |
| `/new_task THEMA`  | auth  | Creates a new thread for a task               |
| `/users`           | admin | Lists authorized users for this site          |

## Tests

```bash
npm test
```

Runs Vitest against the pure helpers in `types.ts` and `config.ts`. Handlers in `index.ts` aren't covered by unit tests — they're validated end-to-end by actually sending a Telegram message to a deployed bot.

## License

MIT — see [LICENSE](LICENSE).
