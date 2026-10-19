// Proactive texting — v1 semantics (post-restructure, pre-v2): morning/night
// windows + a 3h silence nudge, ONE shared cooldown + lastDay.
// KNOWN BUG (fixed in the proactive v2 commit): the shared lastDay means any
// silence nudge earlier in the day kills good-morning/good-night for that day.
import { ALLOWED, HISTORY_LIMIT, PRO, log } from "./config.mjs";
import { brain, cleanReply, timeContext } from "./brain.mjs";
import { sendBubbles } from "./telegram.mjs";
import { loadHist, saveHist, loadMeta, saveMeta } from "./memory.mjs";
import { isBusy, setBusy } from "./reply.mjs";

export const ts = (m) => (typeof m?.t === "number" ? m.t : Date.parse(m?.t ?? "")) || null;

export const ist = (now) => {
  const d = new Date(now + 330 * 60_000); // IST = UTC+5:30, no DST
  return { h: d.getUTCHours(), m: d.getUTCMinutes(), day: d.toISOString().slice(0, 10) };
};

export const inWin = (w, h, m) =>
  (h > w[0] || (h === w[0] && m >= w[1])) && (h < w[2] || (h === w[2] && m <= w[3]));

export async function proactiveTick() {
  const chatId = ALLOWED[0];
  if (!chatId || isBusy()) return;
  const now = Date.now();
  const { h, m, day } = ist(now);
  if (h >= PRO.quietFrom && h < PRO.quietTo) return;
  const meta = await loadMeta();
  if (now - (meta.last ?? 0) < PRO.cooldownMs) return;
  const all = await loadHist();
  const msgs = all[chatId] ?? [];
  if (!msgs.length) return;

  let lastUser = 0, lastAny = 0, lastAssistant = null;
  for (const mm of msgs) {
    const t = ts(mm);
    if (!t) continue;
    lastAny = Math.max(lastAny, t);
    if (mm.role === "user") lastUser = Math.max(lastUser, t);
    if (mm.role === "assistant" && t >= (lastAssistant ?? 0)) lastAssistant = t;
  }
  if (!lastUser) return;
  if (now - lastUser > PRO.maxUserSilenceMs) return;
  if (now - lastAny < PRO.activeGapMs) return;

  let trigger = null, hint = "";
  if (inWin(PRO.morning, h, m) && meta.lastDay !== day) {
    trigger = "morning";
    hint = "it's morning where he is. send your good-morning line — the first message of his day.";
  } else if (inWin(PRO.night, h, m) && meta.lastDay !== day) {
    trigger = "night";
    hint = "it's late where he is. send a goodnight, soft closing line.";
  } else if (now - lastUser >= PRO.silenceAfterMs) {
    trigger = "silence";
    hint = `he's been quiet for ${Math.round(((now - lastUser) / 3600_000) * 10) / 10} hours. this is the gone-duration nudge — layer 2, the counting.`;
  }
  if (!trigger) return;

  log(`proactive trigger: ${trigger}`);
  setBusy(true);
  try {
    const res = await brain(
      msgs,
      `${timeContext(now, lastAssistant)}\n\n[proactive: you are texting him FIRST, unprompted — ${hint} Write it now: 1-2 short bubbles, no name label, no stage directions unless the chat already uses them.]`,
    );
    if (res.status !== 200 || !res.text) {
      log("proactive brain failed:", res.status, res.detail ?? "");
      return;
    }
    const out = cleanReply(res.text);
    if (!out) return;
    all[chatId] = msgs.concat({ role: "assistant", content: out, t: Date.now() }).slice(-HISTORY_LIMIT);
    await saveHist(all);
    await saveMeta({ last: Date.now(), lastDay: ist(Date.now()).day, trigger });
    await sendBubbles(chatId, out);
    log(`proactive ${trigger} sent (${out.length} chars)`);
  } finally {
    setBusy(false);
  }
}
