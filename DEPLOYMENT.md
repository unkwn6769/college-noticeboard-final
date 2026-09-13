# College Noticeboard — Deployment Guide

This release is packaged as a hybrid deployment:

- **Frontend:** Vite/React static site, suitable for Cloudflare Pages.
- **Application API:** the existing Express/PostgreSQL backend, containerized for a Node service such as Northflank.
- **Migration acceleration:** the Cloudflare Worker under `cloudflare/api/`, using Hyperdrive and Cloudflare Queues.

The uploaded source already contains the project-specific Hyperdrive and Queue bindings. A different Cloudflare account should create replacement resources and update `cloudflare/api/wrangler.jsonc` accordingly.

## 1. Database

Use the existing PostgreSQL database. Before production startup, apply `server/db/schema.sql` to a new database, or let the application's schema/bootstrap routines perform their supported migrations against an existing database.

Do not put `DATABASE_URL` into the repository or release ZIP.

## 2. Express backend

The repository root contains `Dockerfile` for the backend service.

Required runtime variables include:

- `DATABASE_URL`
- `TOKEN_ENCRYPTION_KEY`
- `ADMIN_GOOGLE_CLIENT_ID`
- `ADMIN_GOOGLE_CLIENT_SECRET`
- `ADMIN_GOOGLE_REDIRECT_URI`
- `ADMIN_SESSION_SECRET`
- `ALLOWED_ORIGINS`
- the existing Google Drive / migration variables from `.env.example`

Set `ALLOWED_ORIGINS` to the public frontend origin, for example:

`https://your-site.example`

The service listens on `PORT` (default `3001`).

Health endpoint:

`GET /health`

## 3. Frontend

Build the Vite app with:

```bash
npm install
npm run build
```

The output directory is `dist/`.

Set:

`VITE_API_URL=https://your-api.example`

The included `public/_redirects` keeps React Router routes working on Cloudflare Pages.

## 4. Cloudflare Worker

From `cloudflare/api`:

```bash
npm install
npx wrangler types
npx wrangler deploy
```

Set secrets with:

```bash
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in local values. Never commit `.dev.vars`.

The Worker configuration contains:

- Hyperdrive binding `HYPERDRIVE`
- Queue producer binding `MIGRATION_QUEUE`
- Queue consumer for `college-noticeboard-migrations`

The current Worker entrypoint is intentionally a foundation: its HTTP routes expose health checks and its queue handler currently logs received messages. The complete Express API remains the production application API. The migration processor modules are included for the Cloudflare migration path but are not silently presented as a replacement for the whole server.

## 5. Important architecture note

The Cloudflare Worker source in this release is the migration-execution foundation. The Express server remains the complete application API and admin API. The Worker does **not** replace every Express route.

That means the normal production deployment is still:

`Browser → Express API`

with Cloudflare used for migration execution/acceleration and Hyperdrive access to PostgreSQL.

Do not remove the Express API unless every `/api/*` route used by the frontend and admin panel has been ported and tested.

## 6. Security checklist

- Keep `.env`, `.dev.vars`, OAuth client secrets, refresh tokens, and database credentials outside the repository.
- Use HTTPS for the frontend and API in production.
- Use a production `ADMIN_SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY`.
- Configure the Google OAuth redirect URIs to the actual production endpoints.
- Set `ALLOWED_ORIGINS` explicitly; do not use `*` with credentialed admin requests.

## 7. Local verification

Frontend:

```bash
npm run build
npm run lint
```

Application server:

```bash
npm --prefix server run preflight
npm test
```

Cloudflare Worker:

```bash
cd cloudflare/api
npx tsc --noEmit
npm test
```
