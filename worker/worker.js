// Cloudflare Worker: proxies POST /v1/messages to Google's Gemini API (which
// has a free tier), attaching a server-side API key (set via
// `wrangler secret put GEMINI_API_KEY`) so the key never has to live in the
// browser. Restricts CORS to ALLOWED_ORIGIN so other sites can't ride on your
// API quota.
//
// The client sends an Anthropic-Messages-shaped body ({ model, max_tokens,
// system, messages }) and this worker translates it to/from Gemini's API
// shape, so index.html doesn't need to know which provider is behind this
// endpoint.

const ALLOWED_ORIGIN = "https://seanogflynn-dev.github.io";

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
    if (!env.GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Server is missing GEMINI_API_KEY" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(request) } }
      );
    }

    let clientRequest;
    try {
      clientRequest = JSON.parse(await request.text());
    } catch (e) {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(request) } }
      );
    }

    const model = clientRequest.model || "gemini-2.5-flash";
    const userMessage = (clientRequest.messages || []).find((m) => m.role === "user");

    const geminiRequest = {
      contents: [{ role: "user", parts: [{ text: userMessage ? userMessage.content : "" }] }],
      generationConfig: { maxOutputTokens: clientRequest.max_tokens || 2048 },
    };
    if (clientRequest.system) {
      geminiRequest.system_instruction = { parts: [{ text: clientRequest.system }] };
    }

    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiRequest),
      }
    );

    const upstreamJson = await upstream.json();

    if (!upstream.ok) {
      // Forward Gemini's error as-is so it's visible in the browser's network tab.
      return new Response(JSON.stringify(upstreamJson), {
        status: upstream.status,
        headers: { "Content-Type": "application/json", ...corsHeaders(request) },
      });
    }

    const text = (upstreamJson.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("");

    // Re-shape into the Anthropic-Messages response shape index.html expects.
    const anthropicShaped = { content: [{ type: "text", text }] };

    return new Response(JSON.stringify(anthropicShaped), {
      status: 200,
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
