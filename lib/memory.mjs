// History + proactive-meta storage. Cloudflare KV via the worker's /mem
// bridge when MEM_URL is set (Actions runners are ephemeral), else local files.
// KV failures are LOUD: the 10-14..10-19 dead-bridge period showed that a
// silent fallback makes a half-dead bot look green.
// 
// Race condition fix: loadHist returns {data, version}, saveHist requires version match.
// Simple optimistic locking — last write wins but logs conflict.
import fs from "node:fs";
import {
  HISTORY_FILE, OFFSET_FILE, STATE_FILE, MEM_URL, MEM_SECRET, log,
} from "./config.mjs";

const readJson = (p, d) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; }
};
const writeJsonAtomic = (p, data) => {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, p);
};

export const readOffset = () => {
  try { return parseInt(fs.readFileSync(OFFSET_FILE, "utf8").trim(), 10) || 0; } catch { return 0; }
};
export const writeOffset = (v) => {
  try { fs.writeFileSync(OFFSET_FILE, String(v)); } catch (e) { log("writeOffset failed:", e); }
};

let loadWarned = false;
function kvWarnOnce(what, e) {
  if (loadWarned) return;
  loadWarned = true;
  log(`KV ${what} failing — using in-process state only:`, e?.message ?? e);
}

async function kvGet(key) {
  const r = await fetch(`${MEM_URL}/mem?key=${key}`, {
    headers: { "X-Clara-Mem": MEM_SECRET, "User-Agent": "curl/8.22.0" },
  });
  if (!r.ok) throw new Error(`kv get ${r.status}`);
  return r.text();
}
async function kvPut(key, body) {
  const r = await fetch(`${MEM_URL}/mem?key=${key}`, {
    method: "PUT",
    headers: { "X-Clara-Mem": MEM_SECRET, "Content-Type": "text/plain", "User-Agent": "curl/8.22.0" },
    body,
  });
  if (!r.ok) throw new Error(`kv put ${r.status}`);
}

let histCache = { data: {}, version: 0 };
export async function loadHist() {
  if (!MEM_URL) return { data: readJson(HISTORY_FILE, {}), version: 0 };
  try {
    const txt = await kvGet("hist:all");
    histCache = { data: txt ? JSON.parse(txt) : {}, version: Date.now() };
  } catch (e) {
    kvWarnOnce("hist:all", e);
  }
  return histCache;
}
export async function saveHist(h, expectedVersion) {
  if (!MEM_URL) return writeJsonAtomic(HISTORY_FILE, h);
  if (expectedVersion !== undefined && histCache.version !== expectedVersion) {
    log("saveHist version conflict — reloading and retrying once");
    await loadHist(); // refresh cache
    if (histCache.version !== expectedVersion) {
      log("saveHist ABORTED: concurrent modification detected");
      return false;
    }
  }
  histCache = { data: h, version: Date.now() };
  try {
    await kvPut("hist:all", JSON.stringify(h));
    return true;
  } catch (e) {
    log("mem save failed:", e?.message ?? e);
    return false;
  }
}

let stateCache = {};
// Proactive state: { morning: {day, last}, night: {day, last}, ladder: {stage, lastNudgeAt} }
// Human state: { mood: {current, since, trigger}, patterns: {...}, commitments: [...], spontaneous: {lastAt} }
export async function loadState() {
  if (!MEM_URL) return readJson(STATE_FILE, {});
  try {
    const txt = await kvGet("hist:state");
    stateCache = txt ? JSON.parse(txt) : {};
  } catch (e) {
    kvWarnOnce("hist:state", e);
  }
  // Ensure all fields exist
  if (!stateCache.mood) stateCache.mood = { current: "warm", since: Date.now(), trigger: "init" };
  if (!stateCache.patterns) stateCache.patterns = { replyHours: [], gaps: [], lateNightCount: 0, total: 0 };
  if (!stateCache.commitments) stateCache.commitments = [];
  if (!stateCache.spontaneous) stateCache.spontaneous = { lastAt: 0 };
  return stateCache;
}
export async function saveState(s) {
  if (!MEM_URL) return writeJsonAtomic(STATE_FILE, s);
  stateCache = s;
  try {
    await kvPut("hist:state", JSON.stringify(s));
  } catch (e) {
    log("state save failed:", e?.message ?? e);
  }
}

// Read marker written by listener.py: { read_at, max_id } | null.
// Seen-data only REFINES the ladder (flavor + timing) — never loud, never blocking.
export async function loadSeen(chatId) {
  if (!MEM_URL) return null;
  try {
    const txt = await kvGet(`hist:seen:${chatId}`);
    return txt ? JSON.parse(txt) : null;
  } catch {
    return null;
  }
}

// Mood helpers
export function updateMood(state, newMood, trigger) {
  const now = Date.now();
  state.mood = { current: newMood, since: now, trigger };
  return state;
}

export function getMoodContext(state) {
  const { current, since, trigger } = state.mood || { current: "warm", since: Date.now(), trigger: "init" };
  const ageMs = Date.now() - since;
  const decayed = ageMs > 6 * 3600_000 ? " (fading)" : "";
  return `[mood: ${current}${decayed}, since ${Math.round(ageMs / 60000)}min ago (trigger: ${trigger})]`;
}

// Pattern tracking
export function recordUserPattern(state, chatId, now) {
  const { h } = new Date(now + 330 * 60_000); // IST hour
  const p = state.patterns;
  p.replyHours.push(h);
  if (h >= 22 || h < 6) p.lateNightCount++;
  p.total++;
  // Keep last 100 samples
  if (p.replyHours.length > 100) {
    const removed = p.replyHours.shift();
    if (removed >= 22 || removed < 6) p.lateNightCount--;
    p.total = Math.max(0, p.total - 1);
  }
  return state;
}

export function getPatternContext(state) {
  const p = state.patterns;
  if (p.total < 5) return "";
  const avgHour = p.replyHours.reduce((a, b) => a + b, 0) / p.replyHours.length;
  const lateNightPct = Math.round((p.lateNightCount / p.total) * 100);
  const typical = Math.round(avgHour);
  return `[patterns: typically replies around ${typical}:00 IST, ${lateNightPct}% after 10pm]`;
}

// Commitment tracking
import { HUMAN } from "./config.mjs";

export function extractCommitments(text, role) {
  if (role !== "assistant") return [];
  const { commitmentKeywords, commitmentDefaultMs } = HUMAN;
  const lower = text.toLowerCase();
  const commitments = [];
  for (const kw of commitmentKeywords) {
    if (lower.includes(kw)) {
      commitments.push({ text: text.slice(0, 100), deadline: Date.now() + commitmentDefaultMs, fulfilled: false });
    }
  }
  return commitments;
}

export function checkCommitments(state) {
  const now = Date.now();
  const due = state.commitments.filter(c => !c.fulfilled && c.deadline < now);
  return due.map(c => c.text);
}
