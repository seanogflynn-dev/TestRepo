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
4. Deploy:
   ```
   wrangler deploy
   ```
5. Wrangler prints your Worker's URL, e.g. `https://job-sourcer-proxy.<your-subdomain>.workers.dev`.

## Wire it up to the site

In `../index.html`, find the line near the top of the `<script>` block:

```js
const AI_PROXY_URL = "https://REPLACE-WITH-YOUR-WORKER.workers.dev/v1/messages";
```

Replace it with your deployed Worker URL + `/v1/messages`, commit, and push —
GitHub Pages will pick up the change automatically.

## Notes

- If you ever host the site from a different origin, update `ALLOWED_ORIGIN` in `worker.js` to match.
- Cloudflare Workers' free tier (100,000 requests/day) is more than enough for personal use.
- Already have a `ANTHROPIC_API_KEY` secret set from a previous version of this worker? It's unused now and can be left in place or removed with `wrangler secret delete ANTHROPIC_API_KEY`.
