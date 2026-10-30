// Inbound reply orchestration: memory + brain + texting.
import { HISTORY_LIMIT, log, HUMAN } from "./config.mjs";
import { brain, cleanReply, timeContext, detectOffMoment, buildHumanContext } from "./brain.mjs";
import { send, sendBubbles, startTyping } from "./telegram.mjs";
import { loadHist, saveHist, loadState, saveState, updateMood, recordUserPattern, extractCommitments } from "./memory.mjs";

let busy = false; // true while a reply is in flight — no mid-chat proactive
export const isBusy = () => busy;
export const setBusy = (v) => { busy = v; };

export async function reply(chatId, text, { persist = true } = {}) {
  setBusy(true);
  const stopTyping = startTyping(chatId);
  try {
    // He texted — the escalation ladder resets; pending rungs are moot.
    const state = await loadState();
    if (persist) {
      if (state.ladder?.stage) {
        state.ladder = { stage: 0 };
        await saveState(state);
      }
      // Record his reply pattern
      recordUserPattern(state, chatId, Date.now());
      await saveState(state);
    }
    const { data: all, version } = await loadHist();
    const prev = all[chatId] ?? [];
    const now = Date.now();
    const history = prev.concat({ role: "user", content: text, t: now });
    const lastAssistantAt = [...prev].reverse().find((m) => m.role === "assistant")?.t ?? null;
    
    // Detect mood shift from his message
    const lower = text.toLowerCase();
    if (lower.includes("love") || lower.includes("miss") || lower.includes("❤") || lower.includes("😘")) {
      updateMood(state, "warm", "affection");
    } else if (lower.includes("sorry") || lower.includes("busy") || lower.includes("late")) {
      updateMood(state, "soft", "apology");
    } else if (lower.includes("angry") || lower.includes("mad") || lower.includes("annoyed")) {
      updateMood(state, "tense", "conflict");
    } else if (lower.includes("tired") || lower.includes("exhausted") || lower.includes("sleepy")) {
      updateMood(state, "tired", "fatigue");
    } else if (lower.includes("lol") || lower.includes("haha") || lower.includes("😂") || lower.includes("🤣")) {
      updateMood(state, "playful", "humor");
    }
    
    const res = await brain(history, timeContext(now, lastAssistantAt), state);
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
    
    // Extract commitments from her reply
    if (persist) {
      const commitments = extractCommitments(out, "assistant");
      if (commitments.length) {
        state.commitments.push(...commitments);
        await saveState(state);
      }
    }
    
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
