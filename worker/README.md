# Job Sourcer API proxy

A small Cloudflare Worker that proxies `POST /v1/messages` to Google's Gemini
API (which has a free tier), holding the API key server-side so it's never
exposed in the browser. It also restricts CORS to the GitHub Pages origin
(`https://seanogflynn-dev.github.io`) so other sites can't use your API
key/quota.

The client (`index.html`) sends an Anthropic-Messages-shaped request body;
the worker translates it to Gemini's request format and translates the
response back, so the rest of the site doesn't need to know which provider
is behind this endpoint.

## Get a free Gemini API key

1. Go to https://aistudio.google.com/apikey (sign in with a Google account).
2. Click **Create API key**.
3. Copy the key — you'll paste it in the next step.

Google AI Studio's free tier has generous daily rate limits and doesn't
require a credit card.

## Deploy

1. Install wrangler (once): `npm install -g wrangler`
2. From this `worker/` directory, log in: `wrangler login`
3. Set your Gemini API key as a secret (you'll be prompted to paste it):
   ```
   wrangler secret put GEMINI_API_KEY
   ```
4. Create the KV namespace used to store the daily job shortlist and your
   Yes/No/Applied decisions:
   ```
   wrangler kv namespace create ROLES_KV
   ```
   It prints an `id`. Open `wrangler.toml` and replace
   `REPLACE-WITH-YOUR-KV-NAMESPACE-ID` with that id.
5. Set a secret the daily Routine will use to authenticate when it pushes
   new roles in (pick any long random string — a password generator's
   output is fine):
   ```
   wrangler secret put INGEST_SECRET
   ```
6. Deploy:
   ```
   wrangler deploy
   ```
7. Wrangler prints your Worker's URL, e.g. `https://job-sourcer-proxy.<your-subdomain>.workers.dev`.

## Wire it up to the site

In `../index.html`, find the line near the top of the `<script>` block:

```js
const AI_PROXY_URL = "https://REPLACE-WITH-YOUR-WORKER.workers.dev/v1/messages";
```

Replace it with your deployed Worker URL + `/v1/messages`, commit, and push —
GitHub Pages will pick up the change automatically.

## Roles API (shortlist + application tracker)

- `GET /v1/roles` — returns `{ roles: [...] }`. Called by the app on load to
  show today's shortlist and the Applications archive.
- `POST /v1/roles/decision` — body `{ id, status }` where status is one of
  `pending`/`yes`/`no`/`applied`. Called by the app when you click a
  decision button; setting `applied` stamps `appliedAt`.
- `POST /v1/roles/ingest` — body `{ roles: [{ company, role, rationale,
  link, score }] }`, requires header `X-Ingest-Secret: <INGEST_SECRET>`.
  Called by the daily job-search Routine after it scores new roles.
  Duplicate roles (same company + role + link) are silently skipped.

The app's "Run search now" button doesn't call the Worker at all — it copies
a prompt ("Fire my \"Daily Partner Success job search\" Routine now.") for
you to paste into a Claude Code / Cowork chat. The real job search needs an
authenticated agent session (web browsing, link verification, `.docx`
generation), and firing it that way draws on your existing plan's usage
instead of the separately-metered Anthropic API — there's no way to trigger
it for free from a plain webpage button.

## Notes

- If you ever host the site from a different origin, update `ALLOWED_ORIGIN` in `worker.js` to match.
- Cloudflare Workers' free tier (100,000 requests/day) and KV's free tier (1 GB storage, 100,000 reads/day) are both more than enough for personal use.
- Already have a `ANTHROPIC_API_KEY` secret set from a previous version of this worker? It's unused now and can be left in place or removed with `wrangler secret delete ANTHROPIC_API_KEY`.
