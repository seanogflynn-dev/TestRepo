// Cloudflare Worker: proxies POST /v1/messages to the Anthropic API,
// attaching a server-side API key (set via `wrangler secret put ANTHROPIC_API_KEY`)
// so the key never has to live in the browser. Restricts CORS to ALLOWED_ORIGIN
// so other sites can't ride on your API quota.

const ALLOWED_ORIGIN = "https://seanogflynn-dev.github.io";
const ANTHROPIC_VERSION = "2023-06-01";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/v1/messages") {
      return new Response("Not found", { status: 404, headers: corsHeaders(request) });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders(request) });
    }
    if (!env.ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Server is missing ANTHROPIC_API_KEY" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(request) } }
      );
    }

    const body = await request.text();

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body,
    });

    const responseBody = await upstream.text();
    return new Response(responseBody, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...corsHeaders(request) },
    });
  },
};

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}
