// Zen free-tier gate recipe (opencode 1.19): new UA, ascending msg_ ids,
// bit-inverted ses_ ids. Copied from opencode-free-proxy/server.mjs — keep in sync.
import fs from "node:fs";
import path from "node:path";
import { WORKER_DIR, MODEL } from "./config.mjs";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const OC_UA = "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
const random14 = () =>
  Array.from({ length: 14 }, () => BASE62[Math.floor(Math.random() * 62)]).join("");
const ocIdBytes = (v) => {
  let out = "";
  for (let w = 0; w < 6; w++)
    out += Number((v >> BigInt(40 - 8 * w)) & 0xffn).toString(16).padStart(2, "0");
  return out;
};

let _ascMs = 0, _ascK = 0, _descMs = 0, _descK = 0;
export const ocId = (prefix) => {
  const now = Date.now();
  if (now !== _ascMs) { _ascMs = now; _ascK = 0; }
  _ascK++;
  return `${prefix}_${ocIdBytes(BigInt(now) * 0x1000n + BigInt(_ascK))}${random14()}`;
};
export const ocIdSession = () => {
  const now = Date.now();
  if (now !== _descMs) { _descMs = now; _descK = 0; }
  _descK++;
  const v = BigInt(now) * 0x1000n + BigInt(_descK);
  return `ses_${ocIdBytes(~v)}${random14()}`;
};

let gateTools = null;
function tools() {
  if (!gateTools)
    gateTools = JSON.parse(
      fs.readFileSync(
        fs.existsSync(path.join(process.cwd(), "gate-tools-full.json"))
          ? path.join(process.cwd(), "gate-tools-full.json")
          : path.join(WORKER_DIR, "gate-tools-full.json"),
        "utf8",
      ),
    );
  return gateTools;
}

// Stream call to Zen (the gate requires stream:true + the decoy tools).
// Returns { status, text, detail }.
export async function zen(messages, zenKey) {
  const session = ocIdSession();
  const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${zenKey}`,
      "User-Agent": OC_UA,
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      "x-opencode-request": ocId("msg"),
      "x-opencode-session": session,
      "x-opencode-session-id": session,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      tools: tools(),
      tool_choice: "none",
    }),
  });
  if (!res.ok)
    return { status: res.status, text: "", detail: (await res.text()).slice(0, 200) };
  return { status: 200, text: await streamToText(res) };
}

// Parse an SSE chat-completion stream into plain assistant text.
async function streamToText(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let out = "";
  const extract = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return;
    try {
      const d = JSON.parse(data)?.choices?.[0]?.delta?.content;
      if (typeof d === "string") out += d;
    } catch {}
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop(); // keep incomplete line for next round
    for (const line of lines) extract(line);
  }
  if (buf) extract(buf); // last SSE line may lack a newline
  return out.trim();
}
