#!/usr/bin/env node
// Clara — Telegram girlfriend bot, long-polling.
// Live path: GitHub Actions self-chaining workflow; also runnable anywhere.
// Brain: OpenCode Zen free tier via the gate recipe (lib/gate.mjs).
// Memory: Cloudflare KV through the worker /mem bridge (lib/memory.mjs).
//
// Env (state-dir env file locally, or repo secrets/vars on Actions):
//   TELEGRAM_BOT_TOKEN  from @BotFather
//   ZEN_KEY             optional; defaults to ~/.local/share/opencode/auth.json
//   ALLOWED_CHAT_IDS    comma-separated; empty = anyone (not recommended)
//   MEM_URL             worker base URL for KV bridge; empty = local files
//   MEM_SECRET          X-Clara-Mem header value (= wrangler TG_SECRET)
//
// Usage:
//   node clara-poller.mjs            run the poller (workflow does this)
//   node clara-poller.mjs --say "hi" one-shot send (use --chat <id>)
//   node clara-poller.mjs --test     run the brain on a test prompt, no Telegram
//   node clara-poller.mjs --fake <chatId> <text>   full inbound path by hand

import {
  ALLOWED, GREET_ON_START, MAX_RUNTIME_MS, MEM_URL, TOKEN, ZEN_KEY, log,
} from "./lib/config.mjs";
import { readOffset, writeOffset } from "./lib/memory.mjs";
import { reply } from "./lib/reply.mjs";
import { proactiveTick } from "./lib/proactive.mjs";
import { brain } from "./lib/brain.mjs";
import { send, tg } from "./lib/telegram.mjs";

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}
if (!ZEN_KEY) {
  console.error("ZEN_KEY missing (and auth.json unreadable)");
  process.exit(1);
}

// MAX_RUNTIME_MS: exit cleanly after N ms so a GitHub Actions job can chain
// into the next run instead of being killed at the 6h limit.
if (MAX_RUNTIME_MS)
  setTimeout(() => { log("max runtime reached, exiting"); process.exit(0); }, MAX_RUNTIME_MS).unref();

async function poll() {
  let offset = readOffset();
  log(`polling (allowed: ${ALLOWED.join(", ") || "ANYONE"}, memory: ${MEM_URL || "local file"})`);
  if (GREET_ON_START && ALLOWED[0]) {
    await send(ALLOWED[0], GREET_ON_START).catch(() => {});
  }
  const proactive = () => proactiveTick().catch((e) => log("proactive error:", e?.message ?? e));
  setTimeout(proactive, 20_000); // first check shortly after wake-up
  setInterval(proactive, 60_000);
  for (;;) {
    let updates = [];
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=50&offset=${offset}&allowed_updates=["message"]`,
        { signal: AbortSignal.timeout(70000) },
      );
      const j = await r.json();
      updates = j.result ?? [];
    } catch (e) {
      log("poll error:", e.message ?? e);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      writeOffset(offset); // non-fatal: never let state trouble drop a message
      const msg = u.message;
      const chatId = String(msg?.chat?.id ?? "");
      const text = (msg?.text ?? "").trim();
      if (!text || !chatId) continue;
      if (ALLOWED.length && !ALLOWED.includes(chatId)) {
        log(`ignored message from ${chatId} (not allowlisted)`);
        continue;
      }
      log(`msg from ${chatId}: ${JSON.stringify(text.slice(0, 80))}`);
      if (text.startsWith("/start")) {
        await send(chatId, "hey. text me like a person, i'll text back.");
        continue;
      }
      // fire and forget: each chat handled independently, order per chat kept by awaiting
      reply(chatId, text).catch((e) => log("reply error:", e));
    }
  }
}

// ── one-shot modes ────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv[0] === "--say") {
  const chat = argv.includes("--chat") ? argv[argv.indexOf("--chat") + 1] : ALLOWED[0];
  if (!chat) {
    console.error("no chat id (use --chat or ALLOWED_CHAT_IDS)");
    process.exit(1);
  }
  const j = await tg("sendMessage", { chat_id: chat, text: argv[1] });
  console.log(j.ok ? `sent to ${chat}` : "failed: " + JSON.stringify(j));
} else if (argv[0] === "--fake") {
  const chat = argv[1];
  const text = argv.slice(2).join(" ");
  const out = await reply(chat, text);
  console.log("reply returned:", JSON.stringify(out));
} else if (argv[0] === "--test") {
  const res = await brain([{ role: "user", content: "say hi in three words" }]);
  console.log("status:", res.status, "reply:", JSON.stringify(res.text), res.detail ?? "");
} else {
  poll();
}
