# College Noticeboard — Quick Start

## Local development

```bash
npm install
npm run dev
```

Backend:

```bash
npm --prefix server run dev
```

## Cloudflare production deployment

1. Put the real local deployment values in `.env`.
2. Run `npx wrangler login --use-keyring` once.
3. Run `./scripts/deploy-cloudflare.sh`.
4. On the first run, add the printed Worker OAuth callback URLs to Google Cloud and `.env`.
5. Run the deployment script again.

The final public endpoints are expected to be:

```text
Frontend: https://college-noticeboard.pages.dev
API:      https://college-noticeboard-api.<your-workers-subdomain>.workers.dev
```

The frontend build receives the API URL automatically from the deployment script, so `VITE_API_URL` does not need to be committed.
