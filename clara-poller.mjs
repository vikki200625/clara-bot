#!/usr/bin/env node
// Clara — Telegram girlfriend bot, long-polling on this machine.
// Brain: OpenCode Zen free tier (mimo-v2.6-flash-free) with the verified gate
// recipe (stream:true + decoy "bash"/"read" tools + ses_/msg_ id headers).
// Zen free tier only accepts calls from the home IP — Cloudflare Workers get
// FreeUsageLimitError 429 — hence long polling here instead of the webhook.
//
// Env (see env file next to this script):
//   TELEGRAM_BOT_TOKEN  from @BotFather
//   ZEN_KEY             optional; defaults to ~/.local/share/opencode/auth.json
//   ALLOWED_CHAT_IDS    comma-separated; empty = anyone (not recommended)
//
// Usage:
//   node bot.mjs               run the poller (systemd does this)
//   node bot.mjs --say "hi"    one-shot send to first allowed chat (or --chat <id>)
//   node bot.mjs --test        run the brain on a test prompt, don't touch Telegram

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const DIR = path.join(HOME, "gf-bot-local");
try {
  fs.mkdirSync(DIR, { recursive: true }); // absent on GitHub runners
} catch {}
const WORKER_DIR = path.join(HOME, "gf-bot-worker");
const HISTORY_FILE = path.join(DIR, "history.json");
const OFFSET_FILE = path.join(DIR, "offset");
const HISTORY_LIMIT = 24;
const MODEL = "mimo-v2.6-flash-free";

const log = (...a) => console.log(new Date().toISOString(), ...a);

function readEnv() {
  const env = { ...process.env };
  const f = path.join(DIR, "env");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  if (!env.ZEN_KEY) {
    try {
      env.ZEN_KEY = JSON.parse(
        fs.readFileSync(path.join(HOME, ".local/share/opencode/auth.json"), "utf8"),
      ).opencode.key;
    } catch {}
  }
  return env;
}
const ENV = readEnv();
const TOKEN = ENV.TELEGRAM_BOT_TOKEN;
const ZEN_KEY = ENV.ZEN_KEY;
const ALLOWED = (ENV.ALLOWED_CHAT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN missing");
  process.exit(1);
}
if (!ZEN_KEY) {
  console.error("ZEN_KEY missing (and auth.json unreadable)");
  process.exit(1);
}

// ── files ─────────────────────────────────────────────────────────────
const MEM_URL = (ENV.MEM_URL || "").replace(/\/$/, ""); // Cloudflare worker /mem
const MEM_SECRET = ENV.MEM_SECRET || "";
const readJson = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return d;
  }
};
const writeJsonAtomic = (p, data) => {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, p);
};
const readOffset = () => {
  try {
    return parseInt(fs.readFileSync(OFFSET_FILE, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
};

// History backend: Cloudflare KV over /mem when MEM_URL is set (Actions runners
// are ephemeral — the file would die with the job), else the local file.
let memCache = {};
async function loadHist() {
  if (!MEM_URL) return readJson(HISTORY_FILE, {});
  memCache = await fetch(`${MEM_URL}/mem?key=hist:all`, {
    headers: { "X-Clara-Mem": MEM_SECRET, "User-Agent": "curl/8.22.0" },
  })
    .then((r) => r.json())
    .catch(() => memCache);
  return memCache;
}
async function saveHist(h) {
  if (!MEM_URL) return writeJsonAtomic(HISTORY_FILE, h);
  memCache = h;
  await fetch(`${MEM_URL}/mem?key=hist:all`, {
    method: "PUT",
    headers: { "X-Clara-Mem": MEM_SECRET, "Content-Type": "text/plain", "User-Agent": "curl/8.22.0" },
    body: JSON.stringify(h),
  }).catch((e) => log("mem save failed:", e.message ?? e));
}

// ── Telegram ──────────────────────────────────────────────────────────
async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) log(`tg ${method} failed:`, JSON.stringify(j).slice(0, 300));
  return j;
}
async function send(chatId, text) {
  for (const chunk of text.match(/[\s\S]{1,4000}/g) ?? [text]) {
    await tg("sendMessage", { chat_id: chatId, text: chunk });
  }
}

// ── Zen brain (gate recipe, same as the Cloudflare worker) ────────────
// OpenCode 1.19 gate: new UA, ascending msg_ ids, bit-inverted (descending)
// ses_ ids. Copied from opencode-free-proxy/server.mjs — keep in sync.
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const OC_UA = "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
const random14 = () =>
  Array.from({ length: 14 }, () => BASE62[Math.floor(Math.random() * 62)]).join("");
const ocIdBytes = (v) => {
  let out = "";
  for (let w = 0; w < 6; w++)
    out += Number((v >> BigInt(40 - 8 * w)) & 0xffn).toString(16).padStart(2, "0");
  return out;
};
let _ascMs = 0, _ascK = 0, _descMs = 0, _descK = 0;
const ocId = (prefix) => {
  const now = Date.now();
  if (now !== _ascMs) { _ascMs = now; _ascK = 0; }
  _ascK++;
  return `${prefix}_${ocIdBytes(BigInt(now) * 0x1000n + BigInt(_ascK))}${random14()}`;
};
const ocIdSession = () => {
  const now = Date.now();
  if (now !== _descMs) { _descMs = now; _descK = 0; }
  _descK++;
  const v = BigInt(now) * 0x1000n + BigInt(_descK);
  return `ses_${ocIdBytes(~v)}${random14()}`;
};

let gateTools = null;
function tools() {
  if (!gateTools)
    gateTools = JSON.parse(
      fs.readFileSync(
        fs.existsSync(path.join(process.cwd(), "gate-tools-full.json"))
          ? path.join(process.cwd(), "gate-tools-full.json")
          : path.join(WORKER_DIR, "gate-tools-full.json"),
        "utf8",
      ),
    );
  return gateTools;
}
function persona() {
  const local = path.join(process.cwd(), "persona-clara.txt");
  try {
    return fs.readFileSync(fs.existsSync(local) ? local : path.join(WORKER_DIR, "persona-clara.txt"), "utf8").trim();
  } catch {
    return "You are a warm, caring girlfriend chatting on Telegram. Reply like real texting: one to three sentences, contractions, no emojis unless he uses them first.";
  }
}

async function zen(messages) {
  const session = ocIdSession();
  const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ZEN_KEY}`,
      "User-Agent": OC_UA,
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      "x-opencode-request": ocId("msg"),
      "x-opencode-session": session,
      "x-opencode-session-id": session,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      tools: tools(),
      tool_choice: "none",
    }),
  });
  if (!res.ok) return { status: res.status, text: "", detail: (await res.text()).slice(0, 200) };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const d = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof d === "string") out += d;
      } catch {}
    }
  }
  return { status: 200, text: out.trim() };
}

async function brain(history) {
  const messages = [{ role: "system", content: persona() }, ...history];
  let res = await zen(messages);
  if (res.status === 429) {
    log("zen 429, retrying in 20s");
    await new Promise((r) => setTimeout(r, 20000));
    res = await zen(messages);
  }
  return res;
}

// ── per-chat memory ───────────────────────────────────────────────────

async function reply(chatId, text) {
  const all = await loadHist();
  const history = (all[chatId] ?? []).concat({ role: "user", content: text });
  const res = await brain(history);
  if (res.status !== 200) {
    const note =
      res.status === 429
        ? "queue's jammed again, text me in a couple minutes?"
        : `brain error ${res.status} — ${res.detail ?? ""}`;
    log(`brain failed for ${chatId}:`, res.status, res.detail ?? "");
    await send(chatId, note);
    return null;
  }
  if (!res.text) {
    log("brain returned empty text");
    return null;
  }
  all[chatId] = history.concat({ role: "assistant", content: res.text }).slice(-HISTORY_LIMIT);
  await saveHist(all);
  await send(chatId, res.text);
  log(`replied to ${chatId} (${res.text.length} chars)`);
  return res.text;
}

// ── poller ────────────────────────────────────────────────────────────
// MAX_RUNTIME_MS: exit cleanly after N ms so a GitHub Actions job can chain
// into the next run instead of being killed at the 6h limit.
const MAX_RUNTIME_MS = parseInt(ENV.MAX_RUNTIME_MS || "0", 10);
if (MAX_RUNTIME_MS) setTimeout(() => { log("max runtime reached, exiting"); process.exit(0); }, MAX_RUNTIME_MS).unref();

async function poll() {
  let offset = readOffset();
  log(`polling (allowed: ${ALLOWED.join(", ") || "ANYONE"}, memory: ${MEM_URL || "local file"})`);
  if (ENV.GREET_ON_START && ALLOWED[0]) {
    await send(ALLOWED[0], ENV.GREET_ON_START).catch(() => {});
  }
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
      try {
        fs.writeFileSync(OFFSET_FILE, String(offset));
      } catch {} // never let state-file trouble drop a message
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
  const chat = argv[argv.indexOf("--chat") + 1] && argv.includes("--chat") ? argv[argv.indexOf("--chat") + 1] : ALLOWED[0];
  if (!chat) {
    console.error("no chat id (use --chat or ALLOWED_CHAT_IDS)");
    process.exit(1);
  }
  const j = await tg("sendMessage", { chat_id: chat, text: argv[1] });
  console.log(j.ok ? `sent to ${chat}` : "failed: " + JSON.stringify(j));
} else if (argv[0] === "--fake") {
  // self-test: run the full inbound path (brain + memory + send) by hand
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
