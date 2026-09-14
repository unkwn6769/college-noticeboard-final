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

## Production

The Node service is the migration control plane and runner. It connects
directly to PostgreSQL using `DATABASE_URL`; Cloudflare is optional HTTP
front-door hosting and does not execute migrations. Run the disposable runner
with `node server/run-migration-runner.js`, or dispatch
`.github/workflows/migration-runner.yml`.

The final public endpoints are expected to be:

```text
Frontend: https://college-noticeboard.pages.dev
API:      https://college-noticeboard-api.<your-workers-subdomain>.workers.dev
```

The frontend build receives the API URL automatically from the deployment script, so `VITE_API_URL` does not need to be committed.
