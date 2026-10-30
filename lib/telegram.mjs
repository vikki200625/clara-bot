// Telegram Bot API surface: raw call, chunked send, typing indicator, bubbles.
// UX improvements: read-delay before typing, variable typing speed by length.
import { TOKEN, log } from "./config.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) log(`tg ${method} failed:`, JSON.stringify(j).slice(0, 300));
  return j;
}

export async function send(chatId, text) {
  for (const chunk of text.match(/[\s\S]{1,4000}/g) ?? [text]) {
    await tg("sendMessage", { chat_id: chatId, text: chunk });
  }
}

// Telegram's "typing…" expires after ~5s, so refresh it while she thinks.
export function startTyping(chatId) {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  };
  tick();
  const iv = setInterval(tick, 4500);
  return () => { stopped = true; clearInterval(iv); };
}

// She texts like a person: each blank-line block is its own bubble, sent a
// beat apart, with a typing flash in between.
// UX: read-delay before first typing (simulates reading), variable speed by length.
export async function sendBubbles(chatId, text) {
  const parts = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const bubbles = parts.length ? parts : [text];
  
  // Initial "reading" delay — humans don't start typing instantly
  const readDelay = Math.min(text.length * 50, 3000);
  await sleep(readDelay);
  
  for (let i = 0; i < bubbles.length; i++) {
    if (i) {
      // Inter-bubble delay: base 700ms + randomness
      await sleep(700 + Math.random() * 1500);
      tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    }
    // Typing duration proportional to bubble length (simulates composing)
    const typingTime = Math.min(bubbles[i].length * 30, 4000);
    const stopTyping = startTyping(chatId);
    await sleep(typingTime);
    stopTyping();
    
    for (const chunk of bubbles[i].match(/[\s\S]{1,4000}/g) ?? [bubbles[i]]) {
      await tg("sendMessage", { chat_id: chatId, text: chunk });
    }
  }
}
