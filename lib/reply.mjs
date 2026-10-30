// Inbound reply orchestration: memory + brain + texting.
import { HISTORY_LIMIT, log } from "./config.mjs";
import { brain, cleanReply, timeContext } from "./brain.mjs";
import { send, sendBubbles, startTyping } from "./telegram.mjs";
import { loadHist, saveHist, loadState, saveState } from "./memory.mjs";

let busy = false; // true while a reply is in flight — no mid-chat proactive
export const isBusy = () => busy;
export const setBusy = (v) => { busy = v; };

export async function reply(chatId, text, { persist = true } = {}) {
  setBusy(true);
  const stopTyping = startTyping(chatId);
  try {
    // He texted — the escalation ladder resets; pending rungs are moot.
    if (persist) {
      const state = await loadState();
      if (state.ladder?.stage) {
        state.ladder = { stage: 0 };
        await saveState(state);
      }
    }
    const { data: all, version } = await loadHist();
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
    if (persist) {
      const ok = await saveHist(all, version);
      if (!ok) log("saveHist failed — history not persisted for this reply");
    }
    await sendBubbles(chatId, out);
    log(`replied to ${chatId} (${out.length} chars)`);
    return out;
  } finally {
    stopTyping();
    setBusy(false);
  }
}
