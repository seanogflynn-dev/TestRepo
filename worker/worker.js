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

// Google periodically retires specific dated/aliased model names (we've hit
// this twice: gemini-2.5-flash and gemini-2.0-flash both went away). Rather
// than hardcode names that keep expiring, ask Gemini's own API which models
// currently exist and support generateContent, and cache the answer for a
// while so we're not calling ListModels on every request.
let cachedModelList = null;
let cachedModelListAt = 0;
const MODEL_LIST_CACHE_MS = 30 * 60 * 1000;

async function getCandidateModels(apiKey) {
  const now = Date.now();
  if (cachedModelList && now - cachedModelListAt < MODEL_LIST_CACHE_MS) {
    return cachedModelList;
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
  );
  if (!res.ok) {
    // Fall back to a best-guess name if we can't even list models.
    return ["gemini-flash-latest"];
  }
  const data = await res.json();
  const models = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => (m.name || "").replace(/^models\//, ""))
    .filter(Boolean);

  // Prefer fast "flash" models (cheaper/faster, better free-tier quota),
  // then anything else that supports generateContent.
  const flash = models.filter((m) => m.includes("flash") && !m.includes("thinking"));
  const rest = models.filter((m) => !flash.includes(m));
  const ordered = [...flash, ...rest];

  cachedModelList = ordered.length ? ordered : ["gemini-flash-latest"];
  cachedModelListAt = now;
  return cachedModelList;
}

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

    const userMessage = (clientRequest.messages || []).find((m) => m.role === "user");

    const geminiRequest = {
      contents: [{ role: "user", parts: [{ text: userMessage ? userMessage.content : "" }] }],
      generationConfig: { maxOutputTokens: clientRequest.max_tokens || 2048 },
    };
    if (clientRequest.system) {
      geminiRequest.systemInstruction = { parts: [{ text: clientRequest.system }] };
    }

    // Models get retired or briefly overloaded on the free tier. Fetch the
    // current list of models Google actually supports (cached), try a
    // client-requested model first if given, then fall through the list -
    // retrying an overloaded (503) model briefly, and moving straight past a
    // retired (404) one.
    const discovered = await getCandidateModels(env.GEMINI_API_KEY);
    const modelsToTry = clientRequest.model
      ? [clientRequest.model, ...discovered.filter((m) => m !== clientRequest.model)]
      : discovered;

    let upstream, upstreamJson;
    const attemptsLog = [];

    for (let i = 0; i < modelsToTry.length; i++) {
      const model = modelsToTry[i];
      for (let attempt = 0; attempt < 2; attempt++) {
        upstream = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(geminiRequest),
          }
        );
        if (upstream.status !== 503) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
      upstreamJson = await upstream.json();
      attemptsLog.push({ model, status: upstream.status });
      if (upstream.ok) break;
      if (upstream.status !== 503 && upstream.status !== 404) break;
    }

    if (!upstream.ok) {
      // Forward Gemini's error as-is, plus which models we tried, so it's
      // visible in the browser's network tab for debugging.
      return new Response(
        JSON.stringify({ ...upstreamJson, _debug_attempts: attemptsLog, _debug_candidates: modelsToTry }),
        {
          status: upstream.status,
          headers: { "Content-Type": "application/json", ...corsHeaders(request) },
        }
      );
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
