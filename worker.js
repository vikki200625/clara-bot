// gf-bot — Cloudflare Worker, now ONLY the KV /mem bridge for the poller.
// The Worker brain path died when Zen free tier banned Cloudflare egress IPs
// (FreeUsageLimitError 429) and the Telegram webhook was deleted; the poller
// on GitHub Actions is the live bot. This worker survives as its state API:
// history + proactive state + seen-markers live in KV, reached via /mem.
// Guarded by the same secret as the old webhook; only hist: keys are reachable.

const MAX_BODY_SIZE = 100 * 1024; // 100KB limit on PUT bodies

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    
    // Health check endpoint
    if (url.pathname === "/health") {
      try {
        // Test KV read/write
        const testKey = "hist:health:check";
        await env.MEMORY.put(testKey, "ok", { expirationTtl: 60 });
        const val = await env.MEMORY.get(testKey);
        await env.MEMORY.delete(testKey);
        return new Response(JSON.stringify({ status: "ok", kv: val === "ok" ? "healthy" : "degraded" }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ status: "error", error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    
    if (url.pathname === "/mem") {
      if (req.headers.get("X-Clara-Mem") !== env.TG_SECRET)
        return new Response("no", { status: 403 });
      const key = url.searchParams.get("key") ?? "";
      if (!key.startsWith("hist:")) return new Response("bad key", { status: 400 });
      
      // Size guard on PUT
      if (req.method === "PUT") {
        const cl = req.headers.get("content-length");
        if (cl && parseInt(cl) > MAX_BODY_SIZE) {
          return new Response("payload too large", { status: 413 });
        }
      }
      
      if (req.method === "GET") return new Response((await env.MEMORY.get(key)) ?? "");
      if (req.method === "PUT") {
        const body = await req.text();
        if (body) await env.MEMORY.put(key, body);
        else await env.MEMORY.delete(key);
        return new Response("ok");
      }
      return new Response("no", { status: 405 });
    }
    return new Response("Not Found", { status: 404 });
  },
};
