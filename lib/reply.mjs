// Inbound reply orchestration: memory + brain + texting.
import { HISTORY_LIMIT, log } from "./config.mjs";
import { brain, cleanReply, timeContext } from "./brain.mjs";
import { send, sendBubbles, startTyping } from "./telegram.mjs";
import { loadHist, saveHist } from "./memory.mjs";

let busy = false; // true while a reply is in flight — no mid-chat proactive
export const isBusy = () => busy;
export const setBusy = (v) => { busy = v; };

export async function reply(chatId, text) {
  setBusy(true);
  const stopTyping = startTyping(chatId);
  try {
    const all = await loadHist();
    const prev = all[chatId] ?? [];
    const now = Date.now();
    const history = prev.concat({ role: "user", content: text, t: now });
    const lastAssistantAt = [...prev].reverse().find((m) => m.role === "assistant")?.t ?? null;
    const res = await brain(history, timeContext(now, lastAssistantAt));
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
    const out = cleanReply(res.text);
    if (!out) return null;
    all[chatId] = history
      .concat({ role: "assistant", content: out, t: Date.now() })
      .slice(-HISTORY_LIMIT);
    await saveHist(all);
    await sendBubbles(chatId, out);
    log(`replied to ${chatId} (${out.length} chars)`);
    return out;
  } finally {
    stopTyping();
    setBusy(false);
  }
}
