// Cloudflare Worker: two jobs.
//
// 1. Proxies POST /v1/messages to Google's Gemini API (which has a free
//    tier), attaching a server-side API key (set via
//    `wrangler secret put GEMINI_API_KEY`) so the key never has to live in
//    the browser. The client sends an Anthropic-Messages-shaped body
//    ({ model, max_tokens, system, messages }) and this worker translates
//    it to/from Gemini's API shape, so index.html doesn't need to know
//    which provider is behind this endpoint.
//
// 2. Stores the daily job-search shortlist in Workers KV (binding
//    ROLES_KV) so it can be written by the scheduled Routine (server-side,
//    via POST /v1/roles/ingest, protected by an INGEST_SECRET) and read/
//    updated by the browser (GET /v1/roles, POST /v1/roles/decision) -
//    letting the app show "today's roles" on load and track Yes/No/Applied
//    decisions across devices, since localStorage alone can't bridge a
//    server-side Routine and a static site.
//
// CORS is restricted to ALLOWED_ORIGIN throughout so other sites can't ride
// on your API quota or read/write your roles data from a browser.

const ALLOWED_ORIGIN = "https://seanogflynn-dev.github.io";
const ROLES_KEY = "roles";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    const url = new URL(request.url);

    if (url.pathname === "/v1/messages") return handleMessages(request, env);
    if (url.pathname === "/v1/roles") return handleGetRoles(request, env);
    if (url.pathname === "/v1/roles/decision") return handleDecision(request, env);
    if (url.pathname === "/v1/roles/ingest") return handleIngest(request, env);
    if (url.pathname === "/v1/roles/search-now") return handleSearchNow(request, env);

    return new Response("Not found", { status: 404, headers: corsHeaders(request) });
  },
};

function jsonResponse(request, body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Ingest-Secret",
  };
  if (origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

async function roleId(company, role, link) {
  const data = new TextEncoder().encode(`${company}::${role}::${link}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function loadRoles(env) {
  if (!env.ROLES_KV) return [];
  const raw = await env.ROLES_KV.get(ROLES_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

async function saveRoles(env, roles) {
  await env.ROLES_KV.put(ROLES_KEY, JSON.stringify(roles));
}

// Appends new roles from `incoming` (shape: [{company, role, rationale, link,
// score}]) onto `roles` in place, skipping ones that already exist (same
// company+role+link). Returns how many were actually added.
async function mergeNewRoles(roles, incoming) {
  const existingIds = new Set(roles.map((r) => r.id));
  let added = 0;
  for (const r of incoming) {
    const company = (r.company || "").trim();
    const roleName = (r.role || "").trim();
    const link = (r.link || "").trim();
    if (!company || !roleName) continue;
    const id = await roleId(company, roleName, link);
    if (existingIds.has(id)) continue;
    roles.push({
      id,
      company,
      role: roleName,
      rationale: r.rationale || "",
      link,
      score: r.score ?? null,
      status: "pending",
      addedAt: new Date().toISOString(),
      appliedAt: null,
    });
    existingIds.add(id);
    added++;
  }
  return added;
}

// ---- GET /v1/roles — the app loads this on open ----
async function handleGetRoles(request, env) {
  if (request.method !== "GET") {
    return jsonResponse(request, { error: "Method not allowed" }, 405);
  }
  const roles = await loadRoles(env);
  roles.sort((a, b) => (b.addedAt || "").localeCompare(a.addedAt || ""));
  return jsonResponse(request, { roles });
}

// ---- POST /v1/roles/decision — the app writes Yes/No/Applied here ----
async function handleDecision(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "Method not allowed" }, 405);
  }
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch (e) {
    return jsonResponse(request, { error: "Invalid JSON body" }, 400);
  }
  const { id, status } = body || {};
  const allowed = ["pending", "yes", "no", "applied"];
  if (!id || !allowed.includes(status)) {
    return jsonResponse(request, { error: "Expected { id, status } with status one of " + allowed.join("/") }, 400);
  }

  const roles = await loadRoles(env);
  const role = roles.find((r) => r.id === id);
  if (!role) {
    return jsonResponse(request, { error: "No role with that id" }, 404);
  }
  role.status = status;
  if (status === "applied" && !role.appliedAt) {
    role.appliedAt = new Date().toISOString();
  }
  if (status !== "applied") {
    role.appliedAt = null;
  }
  await saveRoles(env, roles);
  return jsonResponse(request, { role });
}

// ---- POST /v1/roles/ingest — the daily Routine writes here ----
async function handleIngest(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "Method not allowed" }, 405);
  }
  if (!env.INGEST_SECRET || request.headers.get("X-Ingest-Secret") !== env.INGEST_SECRET) {
    return jsonResponse(request, { error: "Unauthorized" }, 401);
  }
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch (e) {
    return jsonResponse(request, { error: "Invalid JSON body" }, 400);
  }
  const incoming = Array.isArray(body.roles) ? body.roles : [];

  const roles = await loadRoles(env);
  const added = await mergeNewRoles(roles, incoming);

  await saveRoles(env, roles);
  return jsonResponse(request, { added, total: roles.length });
}

// ---- POST /v1/roles/search-now — the app's "Run search now" button ----
// Runs a real, live web search directly from the Worker using Gemini's
// Google Search grounding tool (still on the free tier), so a browser click
// can produce real results without needing an authenticated agent session.
// This is a lighter-weight sibling to the full daily Routine: it can't
// click through to verify links resolve or generate CV/cover-letter .docx
// packs (those need real browser/file tools an agent session has), but it
// finds and scores real roles and drops them straight into the same
// tracker, so "Run search now" actually shows something in the app.
async function handleSearchNow(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "Method not allowed" }, 405);
  }
  if (!env.GEMINI_API_KEY) {
    return jsonResponse(request, { error: "Server is missing GEMINI_API_KEY" }, 500);
  }

  const roles = await loadRoles(env);
  const known = roles.map((r) => `${r.company} — ${r.role}`).join("\n") || "(none yet)";

  const sys = `You are a job search assistant with live web search access. Search major job boards and company career pages (LinkedIn Jobs, Indeed, Lever, Greenhouse, Workable, and individual company career sites) for roles matching: Head of Partner Success, VP/SVP Global Partner Success, Director of Alliances, Partner Ecosystem Lead, Head of Partnerships, or similar senior partner/alliances leadership roles, primarily in enterprise SaaS, ideally EMEA/Dublin-based or EMEA-remote. Prefer a company's own live careers board over aggregator sites, which are often stale.

Skip any role that matches one already known - do not repeat these:
${known}

Score each new role 1-10 (one overall number, one decimal is fine) reflecting: salary/compensation signal if disclosed or inferable, company growth trajectory (recent funding/revenue growth/market position), how seriously the company invests in AI as part of its product or roadmap, and fit to a candidate with 20+ years in Partner Success/Alliances, EMEA leadership, enterprise SaaS, scaling through M&A.

Return ONLY valid JSON (no markdown fences, no preamble, no commentary before or after) with this exact shape:
{"roles":[{"company":"...","role":"...","rationale":"1-2 line reason summarizing your score","link":"https://...","score":8.5}]}
If you find no new qualifying roles, return {"roles":[]}.`;

  const geminiRequest = {
    contents: [{ role: "user", parts: [{ text: "Find new roles now." }] }],
    tools: [{ google_search: {} }],
    systemInstruction: { parts: [{ text: sys }] },
    generationConfig: { maxOutputTokens: 4096 },
  };

  const discovered = await getCandidateModels(env.GEMINI_API_KEY);
  let upstream, upstreamJson;
  for (const model of discovered) {
    upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiRequest),
      }
    );
    if (upstream.ok) {
      upstreamJson = await upstream.json();
      break;
    }
    upstreamJson = await upstream.json();
    // Search grounding isn't supported on every model - move on and try the
    // next candidate rather than failing outright.
    if (upstream.status !== 400 && upstream.status !== 404 && upstream.status !== 503) break;
  }

  if (!upstream.ok) {
    return jsonResponse(request, { error: "Search failed", detail: upstreamJson }, upstream.status);
  }

  let text = (upstreamJson.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  text = text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return jsonResponse(request, { error: "Could not parse search results", raw: text }, 502);
  }

  const incoming = Array.isArray(parsed.roles) ? parsed.roles : [];
  const added = await mergeNewRoles(roles, incoming);
  await saveRoles(env, roles);

  return jsonResponse(request, { added, total: roles.length, roles });
}

// ---- POST /v1/messages — Gemini proxy (unchanged behavior) ----

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
  // Several models technically support the generateContent method but only
  // for non-text output (TTS, image/video generation, transcription, etc.)
  // or are specialized/preview products unrelated to chat completion - they
  // 400 on a plain text request. Exclude those by name.
  const NON_TEXT_PATTERN =
    /-tts|-image|-audio|transcribe|robotics|computer-use|customtools|antigravity|deep-research|-clip|lyria|nano-banana|-omni|omni-/i;
  const models = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => (m.name || "").replace(/^models\//, ""))
    .filter(Boolean)
    .filter((m) => !NON_TEXT_PATTERN.test(m));

  // Prefer fast "flash" models (cheaper/faster, better free-tier quota),
  // then anything else that supports generateContent.
  const flash = models.filter((m) => m.includes("flash") && !m.includes("thinking"));
  const rest = models.filter((m) => !flash.includes(m));
  const ordered = [...flash, ...rest];

  cachedModelList = ordered.length ? ordered : ["gemini-flash-latest"];
  cachedModelListAt = now;
  return cachedModelList;
}

async function handleMessages(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders(request) });
  }
  if (!env.GEMINI_API_KEY) {
    return jsonResponse(request, { error: "Server is missing GEMINI_API_KEY" }, 500);
  }

  let clientRequest;
  try {
    clientRequest = JSON.parse(await request.text());
  } catch (e) {
    return jsonResponse(request, { error: "Invalid JSON body" }, 400);
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
    // Keep trying other candidates on: overloaded (503), retired (404), or
    // a bad-request that's actually a wrong-modality rejection (400) -
    // a genuine 400 (e.g. malformed body) will just repeat down the list
    // and surface the last model's error, which is still informative.
    if (upstream.status !== 503 && upstream.status !== 404 && upstream.status !== 400) break;
  }

  if (!upstream.ok) {
    // Forward Gemini's error as-is, plus which models we tried, so it's
    // visible in the browser's network tab for debugging.
    return jsonResponse(
      request,
      { ...upstreamJson, _debug_attempts: attemptsLog, _debug_candidates: modelsToTry },
      upstream.status
    );
  }

  const text = (upstreamJson.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("");

  // Re-shape into the Anthropic-Messages response shape index.html expects.
  return jsonResponse(request, { content: [{ type: "text", text }] });
}
