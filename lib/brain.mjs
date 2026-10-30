// Persona + system-prompt assembly + the one retrying brain call.
import fs from "node:fs";
import path from "node:path";
import { WORKER_DIR, NIM_KEY, log, HUMAN } from "./config.mjs";
import { nim } from "./gate.mjs";
import { getMoodContext, getPatternContext, checkCommitments, extractCommitments } from "./memory.mjs";

export function persona() {
  const local = path.join(process.cwd(), "persona-clara.txt");
  try {
    return fs
      .readFileSync(fs.existsSync(local) ? local : path.join(WORKER_DIR, "persona-clara.txt"), "utf8")
      .trim();
  } catch {
    return "You are a warm, caring girlfriend chatting on Telegram. Reply like real texting: one to three sentences, contractions, no emojis unless he uses them first.";
  }
}

export const REPLY_RULE =
  "[reply limit: hard cap 4 lines, usually 1-2 -- no walls of text, ever]\n" +
  "[format: no name labels (never 'clara:' or '**clara:**'), no quotes wrapping your message, no stage directions unless he starts them -- send the message itself]\n" +
  "[human quirks: write 'ok' not 'okay'; sometimes trail with ~ on soft messages (30%); double letters when excited (yesss, nooo); GM/GN are just 'morning'/'night' not full sentences]";

// Strip a self-applied label/quotes if the model adds one anyway.
export function cleanReply(text) {
  let t = (text ?? "").trim();
  const label = /^\s*(?:\*\*)?\w+(?:\s+\w+)?(?:\*\*)?\s*[:–—-]\s*(?:\*\*)?\s*/i;
  for (let i = 0; i < 3 && label.test(t); i++) t = t.replace(label, "").trim();
  t = t.replace(/^[“"'`]+/, "").replace(/[”"'`]+$/, "");
  
  // Apply consistent quirks
  if (HUMAN.quirks.okNotOkay) {
    t = t.replace(/\bokay\b/gi, "ok");
  }
  return t.trim();
}

const ts = (m) => (typeof m?.t === "number" ? m.t : Date.parse(m?.t ?? "")) || null;

// Real clock for the persona's time-awareness lines.
export function timeContext(now, lastAssistantAt) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(now));
  let line = `[now: ${fmt} IST`;
  const last = ts({ t: lastAssistantAt });
  if (last) line += ` | you last replied ${Math.max(0, Math.round((now - last) / 60000))} min ago`;
  return line + `]`;
}

// Probabilistic "off" moment detector
export function detectOffMoment(history, state) {
  const { shortReplyChance, distractedChance, playfulTeaseChance } = HUMAN;
  const r = Math.random();
  if (r < shortReplyChance) return "short";
  if (r < shortReplyChance + distractedChance) return "distracted";
  if (r < shortReplyChance + distractedChance + playfulTeaseChance) return "playful_tease";
  return null;
}

// Build human context for the prompt
export function buildHumanContext(state, history, offMoment) {
  const parts = [];
  
  // Mood context
  parts.push(getMoodContext(state));
  
  // Pattern context (his habits)
  const patternCtx = getPatternContext(state);
  if (patternCtx) parts.push(patternCtx);
  
  // Commitment reminders
  const due = checkCommitments(state);
  if (due.length) parts.push(`[commitments due: ${due.join("; ")}]`);
  
  // Off-moment directive
  if (offMoment === "short") parts.push("[off-moment: reply with ONE WORD ONLY -- 'k', 'ok', 'mmh', 'yeah', 'sure']");
  if (offMoment === "distracted") parts.push("[off-moment: reply 'sec' or 'hold on' or 'brb' -- you're distracted]");
  if (offMoment === "playful_tease") parts.push("[off-moment: teasing, playful, light -- poke fun gently]");
  
  return parts.length ? parts.join("\n") : "";
}

// history = [{role, content}] (timestamps ignored), context = extra system lines.
// 429 -> one 20s retry (Actions runner has no waitUntil cap; a run lives 30 min).
export async function brain(history, context, state) {
  const offMoment = state ? detectOffMoment(history, state) : null;
  const humanCtx = state ? buildHumanContext(state, history, offMoment) : "";
  
  const messages = [
    {
      role: "system",
      content: [context, REPLY_RULE, persona(), humanCtx].filter(Boolean).join("\n\n"),
    },
    ...history.map(({ role, content }) => ({ role, content })),
  ];
  let res = await nim(messages, NIM_KEY);
  if (res.status === 429) {
    log("nim 429, retrying in 20s");
    await new Promise((r) => setTimeout(r, 20000));
    res = await nim(messages, NIM_KEY);
  }
  return res;
}