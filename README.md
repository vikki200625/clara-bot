# clara-bot

Telegram girlfriend bot (@Clara_cloud_bot).

## Live path (2026-10-19)

- **`.github/workflows/clara.yml`** — self-chaining Actions workflow: each run
  polls Telegram for 30 min (`MAX_RUNTIME_MS`), then dispatches the next run;
  the `*/30` cron is only a watchdog. Zen free tier bans Cloudflare egress IPs
  (`FreeUsageLimitError`), so the bot cannot live on the Worker — the runner's
  IP is allowed.
- **`clara-poller.mjs`** — zero-dependency Node entry: poll loop, CLI modes
  (`--test`, `--say`, `--fake`). Logic lives in `lib/`:
  - `config.mjs` — env + every tunable (windows, timings) in one place
  - `gate.mjs` — the ONE Zen gate recipe (stream + decoy `bash`/`read` tools,
    opencode 1.19 UA, ascending `msg_` / inverted `ses_` ids)
  - `brain.mjs` — persona, system-prompt assembly, reply cleanup, retry
  - `telegram.mjs` — send / typing / multi-bubble pacing
  - `memory.mjs` — KV via the worker `/mem` bridge (local-file fallback)
  - `reply.mjs` — inbound orchestration; resets the ladder on his message
  - `proactive.mjs` — good morning/night + the escalation ladder (pure,
    unit-tested decisions)
- **`listener.py`** — read-receipt sidecar (Python + Telethon, own account
  StringSession): hears `UpdateReadHistoryInbox` for her chat and writes
  `hist:seen:<chatId>` into KV. Proven feasible 2026-10-19.
- **`worker.js`** — Cloudflare Worker, now ONLY the `/mem` KV bridge
  (`gf-bot.vikki200625.workers.dev`; `hist:*` keys only, `X-Clara-Mem` guard).
  The brain/webhook code is gone — history lives in KV because runners are
  ephemeral.

## Proactive behavior (v2)

- **Good morning (08:30–10:30 IST) / goodnight (22:30–23:59 IST):**
  mood-aware — she sees the last 8 messages so tone follows how they left
  things; never quotes old messages. One per day each (own day stamps).
- **The nudge (10:31–22:29 IST only):** independent of old conversation
  (empty history, clock + read-state facts only). Read signal → rung 1 after
  3h (sass); no signal → rung 1 after 5h anyway (never gated on the listener).
  Rung 2 = +4h (drop sass, real worry). Two rungs max, then silence; any
  reply of his resets the ladder. Dormant after 48h of his silence.
- Tests: `node --test` (pure decision functions).

## Secrets / config

Repo secrets: `TELEGRAM_BOT_TOKEN`, `ZEN_KEY`, `MEM_SECRET` (= wrangler
`TG_SECRET`), `TG_API_ID`, `TG_API_HASH`, `TELEGRAM_SESSION` (optional —
ladder degrades to time-based without it).
Repo vars: `MEM_URL`, `ALLOWED_CHAT_IDS`, `GREET_ON_START`.
Local runs: `~/gf-bot-local/env` (mode 600) + KV bridge.
Never put secrets in this repo.

`zen-probe.yml` — manual workflow that calls Zen from a runner and prints
HTTP status + egress IP (answers "which cloud IPs are allowed").
