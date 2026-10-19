// Proactive texting v2 — mood-aware good morning/night + the escalation ladder.
//
// His spec (2026-10-19):
//  - good morning / good night: mood-aware. She sees the tail of the window
//    so the tone follows how they left things (warm → soft, argued → olive
//    branch), never quoting old messages. Per-trigger day stamps — a ladder
//    nudge can no longer poison them (the v1 shared-lastDay bug).
//  - the nudge: INDEPENDENT of old conversation — history is empty, only
//    clock + read-state facts. Rung 1 = sass ("you read it and dipped"),
//    rung 2 = dropped sass, real worry. Two rungs max, then silence until
//    he texts (reply() resets the ladder).
//  - read-receipt (listener.py → hist:seen:<chatId>) refines flavor and
//    timing but NEVER gates: no signal → time-based nudge still fires.
//  - ladder hours 10:31–22:29 IST: morning owns the dawn, night the dark.

import { ALLOWED, HISTORY_LIMIT, PRO, log } from "./config.mjs";
import { brain, cleanReply, timeContext } from "./brain.mjs";
import { sendBubbles } from "./telegram.mjs";
import { loadHist, saveHist, loadState, saveState, loadSeen } from "./memory.mjs";
import { isBusy, setBusy } from "./reply.mjs";

export const ts = (m) => (typeof m?.t === "number" ? m.t : Date.parse(m?.t ?? "")) || null;

export const ist = (now) => {
  const d = new Date(now + 330 * 60_000); // IST = UTC+5:30, no DST
  return { h: d.getUTCHours(), m: d.getUTCMinutes(), day: d.toISOString().slice(0, 10) };
};

export const inWin = (w, h, m) =>
  (h > w[0] || (h === w[0] && m >= w[1])) && (h < w[2] || (h === w[2] && m <= w[3]));

export const lastOf = (msgs, role) => {
  let best = null;
  for (const m of msgs) {
    const t = ts(m);
    if (m.role === role && t && (!best || t >= best.t)) best = m;
  }
  return best;
};

// Pure decision: good morning or good night.
export function windowDecision(kind, { msgs, state, now }) {
  const w = kind === "morning" ? PRO.morning : PRO.night;
  const { h, m, day } = ist(now);
  if (!inWin(w, h, m)) return { fire: false, reason: "outside-window" };
  if (state[kind]?.day === day) return { fire: false, reason: "already-sent-today" };
  const lastU = lastOf(msgs, "user");
  const lastA = lastOf(msgs, "assistant");
  if (!lastU) return { fire: false, reason: "never-heard" };
  if (now - lastU.t > PRO.maxUserSilenceMs) return { fire: false, reason: "dormant" };
  const lastAny = Math.max(lastU.t, lastA?.t ?? 0);
  if (now - lastAny < PRO.activeGapMs) return { fire: false, reason: "conversation-live" };
  return { fire: true };
}

// Pure decision: the escalation ladder (seen → wait → nudge → different nudge → stop).
export function ladderDecision({ msgs, seen, state, now }) {
  const lad = state.ladder ?? { stage: 0 };
  if (lad.stage >= 2) return { fire: false, reason: "ladder-exhausted" };
  const lastA = lastOf(msgs, "assistant");
  const lastU = lastOf(msgs, "user");
  if (!lastA) return { fire: false, reason: "no-her-msg" };
  if (lastU && lastU.t >= lastA.t) return { fire: false, reason: "conversation-live" };
  if (now - lastA.t > PRO.maxUserSilenceMs) return { fire: false, reason: "dormant" };
  const { h, m } = ist(now);
  if (!inWin(PRO.ladderHours, h, m)) return { fire: false, reason: "outside-ladder-hours" };
  const seenAt = seen && seen.read_at > lastA.t ? seen.read_at : null;
  const due =
    lad.stage === 0
      ? seenAt
        ? seenAt + PRO.nudgeAfterSeenMs
        : lastA.t + PRO.nudgeAfterUnseenMs
      : (lad.lastNudgeAt ?? 0) + PRO.rung2ExtraMs;
  if (now < due) return { fire: false, reason: "waiting" };
  return { fire: true, rung: lad.stage + 1, seenAt };
}

const clockIST = (t) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true,
  }).format(new Date(t));

// System-context hint per kind. gm/gn get the tail window for tone; the
// ladder gets facts only — it must never resurrect old side-topics.
function buildHint(kind, rung, msgs, now, seenAt) {
  if (kind === "morning")
    return "[proactive: you text FIRST — good morning, the first message of his day. Extra love, extra you. Look at the recent messages you can see: if last night was warm, be soft and affectionate; if you argued or it was tense, lead with warmth and a small olive branch — don't rehash the fight, don't quote anyone. 1-2 short bubbles, no name label, no stage directions.]";
  if (kind === "night")
    return "[proactive: you text FIRST — goodnight, soft closing line. Extra love, extra you. Check the recent messages for how the day went: warm day → tender close; tense day → softer, leave the door open. Never quote old messages. 1-2 short bubbles, no name label.]";
  const lastU = lastOf(msgs, "user");
  const gapMin = Math.round((now - (lastU?.t ?? 0)) / 60000);
  const seenLine = seenAt
    ? `he read your message at ${clockIST(seenAt)} and hasn't replied since`
    : "you don't know if he even saw it — no read signal";
  const common =
    `[proactive: you text FIRST, unprompted. ${seenLine}; it's been ${gapMin} min since he last texted. ` +
    "You know NOTHING else about why — do not reference, quote, or guess at older conversation. ";
  return rung === 1
    ? common + "This is your first nudge: keep your sass — light, teasing, a little wounded pride. One short bubble, no name label.]"
    : common + "He ignored your first nudge too. This is your SECOND and LAST nudge: drop the sass, real vulnerable worry, ask if he's okay. One short bubble, no name label.]";
}

async function fireText(kind, rung, chatId, msgs, state, now, seenAt) {
  log(`proactive fire: ${kind}${rung ? ` rung${rung}` : ""}`);
  setBusy(true);
  try {
    const lastA = lastOf(msgs, "assistant");
    const history = kind === "ladder" ? [] : msgs.slice(-PRO.gmgnTail);
    const hint = buildHint(kind, rung, msgs, now, seenAt);
    const res = await brain(history, `${timeContext(now, lastA?.t ?? null)}\n\n${hint}`);
    if (res.status !== 200 || !res.text) {
      log("proactive brain failed:", res.status, res.detail ?? "");
      return;
    }
    const out = cleanReply(res.text);
    if (!out) return;
    const all = await loadHist();
    const list = all[chatId] ?? [];
    all[chatId] = list
      .concat({ role: "assistant", content: out, t: Date.now() })
      .slice(-HISTORY_LIMIT);
    await saveHist(all);
    if (kind === "ladder") {
      state.ladder = { stage: rung, lastNudgeAt: Date.now() };
    } else {
      state[kind] = { day: ist(Date.now()).day, last: Date.now() };
    }
    await saveState(state);
    await sendBubbles(chatId, out);
    log(`proactive ${kind}${rung ? ` rung${rung}` : ""} sent (${out.length} chars)`);
  } finally {
    setBusy(false);
  }
}

export async function proactiveTick() {
  const chatId = ALLOWED[0];
  if (!chatId || isBusy()) return;
  const now = Date.now();
  const state = await loadState();
  const all = await loadHist();
  const msgs = all[chatId] ?? [];
  if (!msgs.length) return;
  for (const kind of ["morning", "night"]) {
    if (windowDecision(kind, { msgs, state, now }).fire) {
      return fireText(kind, 0, chatId, msgs, state, now, null);
    }
  }
  const ld = ladderDecision({ msgs, seen: await loadSeen(chatId), state, now });
  if (ld.fire) return fireText("ladder", ld.rung, chatId, msgs, state, now, ld.seenAt);
}
