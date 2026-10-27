// NVIDIA NIM API caller (OpenAI-compatible chat/completions).
// Endpoint: {NIM_BASE_URL}/chat/completions
// Auth: Bearer {NIM_KEY}
// Streams SSE like OpenAI; falls back to one retry on 429.

import { MODEL } from "./config.mjs";

export async function nim(messages, nimKey, baseUrl) {
  const base = baseUrl || "https://integrate.api.nvidia.com/v1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${nimKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 1,
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
    buf = lines.pop();
    for (const line of lines) extract(line);
  }
  if (buf) extract(buf);
  return out.trim();
}
