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
export const META_FILE = path.join(STATE_DIR, "proactive.json");

function readEnvFile() {
  const env = { ...process.env };
  const f = path.join(STATE_DIR, "env");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  if (!env.ZEN_KEY) {
    try {
      env.ZEN_KEY = JSON.parse(
        fs.readFileSync(path.join(HOME, ".local/share/opencode/auth.json"), "utf8"),
      ).opencode.key;
    } catch {}
  }
  return env;
}

const ENV = readEnvFile();

export const TOKEN = ENV.TELEGRAM_BOT_TOKEN;
export const ZEN_KEY = ENV.ZEN_KEY;
export const ALLOWED = (ENV.ALLOWED_CHAT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const MEM_URL = (ENV.MEM_URL || "").replace(/\/$/, "");
export const MEM_SECRET = ENV.MEM_SECRET || "";
export const MAX_RUNTIME_MS = parseInt(ENV.MAX_RUNTIME_MS || "0", 10);
export const GREET_ON_START = ENV.GREET_ON_START || "";

export const MODEL = "mimo-v2.6-flash-free";
export const HISTORY_LIMIT = 24; // last N messages kept per chat

// Proactive schedule (IST). morning/night = [h1,m1,h2,m2] inclusive windows.
export const PRO = {
  cooldownMs: 5 * 3600_000, // min gap between any two unsolicited texts
  quietFrom: 0,
  quietTo: 7, // hours she never texts
  morning: [8, 30, 10, 30],
  night: [22, 30, 23, 59],
  silenceAfterMs: 3 * 3600_000, // quiet this long → gone-duration nudge
  activeGapMs: 25 * 60_000, // conversation stays "live" until this
  maxUserSilenceMs: 24 * 3600_000, // past this the Telegram window is gone too
};

export const log = (...a) => console.log(new Date().toISOString(), ...a);
