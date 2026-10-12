# clara-bot

Telegram girlfriend bot (@Clara_cloud_bot). Two ways to run it:

- `worker.js` — Cloudflare Worker front door (webhook at `/tg`).
  Zen free tier 429s (`FreeUsageLimitError`) from Cloudflare's egress IPs, so the
  brain call fails there. Kept deployed; not the live path.
- `clara-poller.mjs` — zero-dependency Node long-poller (`getUpdates` loop).
  Same gate recipe, persona from `persona-clara.txt`, history in `history.json`.
  This is what actually replies right now (systemd user service `gf-bot` on the box).

Brain: OpenCode Zen free tier, `mimo-v2.6-flash-free`, with the gate recipe —
`stream:true` + decoy tools named exactly `bash`/`read` + `x-opencode-session`
in `ses_<12 hex><14 base62>` format.

`.github/workflows/zen-probe.yml` — manual workflow that calls Zen from a GitHub
runner and prints the HTTP status + egress IP, to answer "which cloud IPs are allowed".

Secrets live in `~/gf-bot-local/env` (mode 600) and in wrangler secrets — never here.
