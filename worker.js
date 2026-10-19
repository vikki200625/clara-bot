// gf-bot — Cloudflare Worker, now ONLY the KV /mem bridge for the poller.
// The Worker brain path died when Zen free tier banned Cloudflare egress IPs
// (FreeUsageLimitError 429) and the Telegram webhook was deleted; the poller
// on GitHub Actions is the live bot. This worker survives as its state API:
// history + proactive state + seen-markers live in KV, reached via /mem.
// Guarded by the same secret as the old webhook; only hist: keys are reachable.

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/mem") {
      if (req.headers.get("X-Clara-Mem") !== env.TG_SECRET)
        return new Response("no", { status: 403 });
      const key = url.searchParams.get("key") ?? "";
      if (!key.startsWith("hist:")) return new Response("bad key", { status: 400 });
      if (req.method === "GET") return new Response((await env.MEMORY.get(key)) ?? "");
      if (req.method === "PUT") {
        const body = await req.text();
        if (body) await env.MEMORY.put(key, body);
        else await env.MEMORY.delete(key);
        return new Response("ok");
      }
      return new Response("no", { status: 405 });
    }
    return new Response("ok");
  },
};
