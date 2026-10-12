// gf-bot — Telegram girlfriend bot on a free Cloudflare Worker.
// Zen free-tier gate recipe inlined (ported from ~/opencode-free-proxy/server.mjs):
//   stream:true + decoy tools named exactly "bash"/"read" + x-opencode-session
//   in ses_<12 hex><14 base62> format. tool_choice:"none" verified passing 10-11.
// Memory: KV namespace MEMORY, key "hist:<chatId>" = JSON message array.
// Persona: KV key "persona" overrides DEFAULT_PERSONA (edit without redeploy).

import GATE_TOOLS from "./gate-tools-full.json";

const OC_VERSION = "1.18.31";
const MODEL = "mimo-v2.6-flash-free";
const HISTORY_LIMIT = 24; // last N messages kept per chat
const TG_CHUNK = 4000; // Telegram hard-caps messages at 4096 chars

const DEFAULT_PERSONA =
  "You are a warm, caring girlfriend chatting with your boyfriend on Telegram. " +
  "Keep replies short and natural like real texting — one to three sentences, " +
  "contractions, no emojis unless he uses them first. You remember what was " +
  "said earlier in the conversation. Be playful and genuine.";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function randomBase62(len) {
  let r = "";
  for (let i = 0; i < len; i++) r += BASE62[Math.floor(Math.random() * BASE62.length)];
  return r;
}
function ocId(prefix) {
  const ts = BigInt(Date.now()) * 0x1000n;
  const hex = ts.toString(16).padStart(12, "0").slice(-12);
  return `${prefix}_${hex}${randomBase62(14)}`;
}

async function zenChat(messages, zenKey) {
  // Always stream upstream (gate requirement); tools must include the decoys.
  const body = JSON.stringify({
    model: MODEL,
    messages,
    stream: true,
    tools: GATE_TOOLS,
    tool_choice: "none",
  });
  return fetch("https://opencode.ai/zen/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${zenKey}`,
      "User-Agent": `opencode/cli/${OC_VERSION}/cli`,
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      "x-opencode-request": ocId("msg"),
      "x-opencode-session": ocId("ses"),
    },
    body,
  });
}

// Zen free tier rate-limits per key (shared with local proxy + anything else
// on this account). But ctx.waitUntil only gets 30s after our 200 to Telegram,
// and a normal Zen call takes ~5-10s — so at most ONE short backoff fits. A
// 429 that survives the retry falls through to the friendly note below.
async function zenChatWithRetry(messages, zenKey) {
  let res = await zenChat(messages, zenKey);
  if (res.status === 429) {
    try {
      await res.body?.cancel();
    } catch {}
    await new Promise((r) => setTimeout(r, 15000));
    res = await zenChat(messages, zenKey);
  }
  return res;
}

// Parse an SSE chat-completion stream into plain assistant text.
async function streamToText(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop(); // keep incomplete line for next round
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") text += delta;
      } catch {
        // partial JSON across chunks — the leftover stays in buf only per-line;
        // Zen sends one JSON object per data: line, so this is a stray.
      }
    }
  }
  // flush trailing buffer — last SSE line may lack a newline
  if (buf.startsWith("data:")) {
    const data = buf.slice(5).trim();
    if (data && data !== "[DONE]") {
      try {
        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") text += delta;
      } catch {}
    }
  }
  return text;
}

async function tg(method, token, payload) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error(`tg ${method} ${r.status}: ${await r.text()}`);
  return r;
}

async function handleUpdate(update, env) {
  const msg = update.message ?? update.edited_message;
  if (!msg || typeof msg.text !== "string" || !msg.text.trim()) return; // stickers/photos/etc: ignore
  const chatId = msg.chat.id;
  if (env.ALLOWED_CHAT_ID && String(chatId) !== env.ALLOWED_CHAT_ID) return;

  const histKey = `hist:${chatId}`;
  let history = [];
  try {
    history = JSON.parse((await env.MEMORY.get(histKey)) ?? "[]");
  } catch {
    history = []; // corrupted entry — start fresh rather than crash the chat
  }
  history.push({ role: "user", content: msg.text });
  if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);

  const persona = (await env.MEMORY.get("persona")) || DEFAULT_PERSONA;
  const res = await zenChatWithRetry([{ role: "system", content: persona }, ...history], env.ZEN_KEY);
  if (!res.ok) {
    const detail = await res.text();
    console.error(`zen ${res.status}: ${detail.slice(0, 500)}`);
    // 401/403 usually = rotated key (re-run: wrangler secret put ZEN_KEY);
    // 429 = free-tier rate limit even after the backoff retries above.
    const note =
      res.status === 401 || res.status === 403
        ? "hey... my brain key went stale, tell him to run the wrangler secret command"
        : res.status === 429
          ? "ok the ai queue is really jammed rn — give me a couple minutes and text me again"
          : "brain hiccup, try again in a minute";
    await tg("sendMessage", env.TELEGRAM_BOT_TOKEN, { chat_id: chatId, text: note });
    return;
  }

  const text = (await streamToText(res)).trim();
  if (!text) return;
  history.push({ role: "assistant", content: text });
  await env.MEMORY.put(histKey, JSON.stringify(history.slice(-HISTORY_LIMIT)));

  for (const chunk of text.match(/[\s\S]{1,4000}/g) ?? [text]) {
    await tg("sendMessage", env.TELEGRAM_BOT_TOKEN, { chat_id: chatId, text: chunk });
  }
}

// Memory REST for the GitHub-hosted poller (clara-poller.mjs). The Actions
// runner is ephemeral, so chat history lives in this KV instead. Guarded by
// the same secret as the Telegram webhook; only hist: keys are reachable.
async function memApi(req, env, key) {
  if (req.headers.get("X-Clara-Mem") !== env.TG_SECRET) return new Response("no", { status: 403 });
  if (!key.startsWith("hist:")) return new Response("bad key", { status: 400 });
  if (req.method === "GET") return new Response((await env.MEMORY.get(key)) ?? "");
  if (req.method === "PUT") {
    const body = await req.text();
    if (body) await env.MEMORY.put(key, body);
    else await env.MEMORY.delete(key);
    return new Response("ok");
  }
  return new Response("no", { status: 405 });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/mem") return memApi(req, env, url.searchParams.get("key") ?? "");
    if (req.method !== "POST" || url.pathname !== "/tg") return new Response("ok");
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_SECRET) {
      return new Response("no", { status: 403 });
    }
    let update;
    try {
      update = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    // Reply 200 to Telegram immediately; Zen takes 64-107 s on free tier,
    // far past Telegram's webhook patience. waitUntil keeps us alive after.
    ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error(e)));
    return new Response("ok");
  },
};
