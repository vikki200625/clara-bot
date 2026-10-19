// History + proactive-meta storage. Cloudflare KV via the worker's /mem
// bridge when MEM_URL is set (Actions runners are ephemeral), else local files.
// KV failures are LOUD: the 10-14..10-19 dead-bridge period showed that a
// silent fallback makes a half-dead bot look green.
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
  try { fs.writeFileSync(OFFSET_FILE, String(v)); } catch {} // never let state trouble drop a message
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

let histCache = {};
export async function loadHist() {
  if (!MEM_URL) return readJson(HISTORY_FILE, {});
  try {
    const txt = await kvGet("hist:all");
    histCache = txt ? JSON.parse(txt) : {};
  } catch (e) {
    kvWarnOnce("hist:all", e);
  }
  return histCache;
}
export async function saveHist(h) {
  if (!MEM_URL) return writeJsonAtomic(HISTORY_FILE, h);
  histCache = h;
  try {
    await kvPut("hist:all", JSON.stringify(h));
  } catch (e) {
    log("mem save failed:", e?.message ?? e);
  }
}

let stateCache = {};
// Proactive state: { morning: {day, last}, night: {day, last}, ladder: {stage, lastNudgeAt} }
export async function loadState() {
  if (!MEM_URL) return readJson(STATE_FILE, {});
  try {
    const txt = await kvGet("hist:state");
    stateCache = txt ? JSON.parse(txt) : {};
  } catch (e) {
    kvWarnOnce("hist:state", e);
  }
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
