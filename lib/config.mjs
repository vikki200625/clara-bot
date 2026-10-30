// Central config: env loading, paths, tunables. Every knob lives here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
export const STATE_DIR = path.join(HOME, "gf-bot-local");
try {
  fs.mkdirSync(STATE_DIR, { recursive: true }); // absent on GitHub runners
} catch {}
export const WORKER_DIR = path.join(HOME, "gf-bot-worker");
export const HISTORY_FILE = path.join(STATE_DIR, "history.json");
export const OFFSET_FILE = path.join(STATE_DIR, "offset");
export const STATE_FILE = path.join(STATE_DIR, "proactive.json");

function readEnvFile() {
  const env = { ...process.env };
  const f = path.join(STATE_DIR, "env");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

const ENV = readEnvFile();

export const TOKEN = ENV.TELEGRAM_BOT_TOKEN;
export const NIM_KEY = ENV.NIM_KEY;
export const NIM_BASE_URL = (ENV.NIM_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
export const ALLOWED = (ENV.ALLOWED_CHAT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const MEM_URL = (ENV.MEM_URL || "").replace(/\/$/, "");
export const MEM_SECRET = ENV.MEM_SECRET || "";
export const MAX_RUNTIME_MS = parseInt(ENV.MAX_RUNTIME_MS || "0", 10);
export const GREET_ON_START = ENV.GREET_ON_START || "";

export const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
export const HISTORY_LIMIT = 24; // last N messages kept per chat

// Proactive schedule (IST). morning/night = [h1,m1,h2,m2] inclusive windows.
// ladderHours: nudges only fire 10:31–22:29 — morning owns the dawn
// (8:30–10:30) and night owns the dark (22:30+), so no double texts.
export const PRO = {
  morning: [8, 30, 10, 30],
  night: [22, 30, 23, 59],
  ladderHours: [10, 31, 22, 29],
  nudgeAfterSeenMs: 3 * 3600_000, // rung 1: he read it, no reply → +3h
  nudgeAfterUnseenMs: 5 * 3600_000, // rung 1 fallback: no read signal → +5h after her msg
  rung2ExtraMs: 4 * 3600_000, // rung 2: +4h after rung 1
  activeGapMs: 25 * 60_000, // conversation stays "live" until this
  maxUserSilenceMs: 48 * 3600_000, // dormant past this (gm/gn + ladder both)
  gmgnTail: 8, // recent window messages she sees for tone
};

// Human-likeness config
export const HUMAN = {
  // Mood persistence
  moodShiftChance: 0.15,      // chance mood shifts on significant event
  moodDecayMs: 6 * 3600_000,  // mood decays toward neutral after 6h
  
  // Probabilistic "off" moments
  shortReplyChance: 0.05,      // 5%: one-word reply
  distractedChance: 0.08,      // 8%: "sec", "hold on", "brb"
  playfulTeaseChance: 0.03,    // 3%: teasing variant
  
  // Typing quirks (consistent identity markers)
  quirks: {
    okNotOkay: true,           // "ok" not "okay"
    tildeTrailing: 0.3,        // 30% chance of trailing ~ on soft messages
    doubleLetters: 0.2,        // 20% chance when excited: yesss, nooo
    noFullSentenceGmGn: true,  // "morning" not "good morning"
  },
  
  // Spontaneous topics (agency, not reactivity)
  spontaneousChance: 0.12,     // 12% per proactive tick (once per ~1-2 days)
  spontaneousMinGapMs: 12 * 3600_000, // min 12h between spontaneous
  
  // Pattern detection (his habits)
  patternWindowMs: 14 * 24 * 3600_000, // 2 weeks of data
  minPatternSamples: 5,        // need at least 5 messages to detect pattern
  
  // Self-commitment tracking
  commitmentKeywords: ["i'll", "i will", "remind me", "later", "soon", "promise", "send you", "make you"],
  commitmentDefaultMs: 24 * 3600_000, // default 24h deadline
};

export const log = (...a) => console.log(new Date().toISOString(), ...a);
