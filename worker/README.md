# Job Sourcer API proxy

A small Cloudflare Worker that proxies `POST /v1/messages` to the Anthropic API,
holding the API key server-side so it's never exposed in the browser. It also
restricts CORS to the GitHub Pages origin (`https://seanogflynn-dev.github.io`)
so other sites can't use your API key/quota.

## Deploy

1. Install wrangler (once): `npm install -g wrangler`
2. From this `worker/` directory, log in: `wrangler login`
3. Set your Anthropic API key as a secret (you'll be prompted to paste it):
   ```
   wrangler secret put ANTHROPIC_API_KEY
   ```
4. Deploy:
   ```
   wrangler deploy
   ```
5. Wrangler prints your Worker's URL, e.g. `https://job-sourcer-proxy.<your-subdomain>.workers.dev`.

## Wire it up to the site

In `../index.html`, find the line near the top of the `<script>` block:

```js
const ANTHROPIC_PROXY_URL = "https://REPLACE-WITH-YOUR-WORKER.workers.dev/v1/messages";
```

Replace it with your deployed Worker URL + `/v1/messages`, commit, and push —
GitHub Pages will pick up the change automatically.

## Notes

- If you ever host the site from a different origin, update `ALLOWED_ORIGIN` in `worker.js` to match.
- Cloudflare Workers' free tier (100,000 requests/day) is more than enough for personal use.
