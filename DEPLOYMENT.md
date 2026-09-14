# College Noticeboard — Cloudflare Deployment

This release uses a direct PostgreSQL migration path:

```text
Browser
  -> Cloudflare Pages (React/Vite)
  -> Cloudflare Worker (Express control-plane API)
     -> Hyperdrive -> Supabase/PostgreSQL
  -> GitHub Actions disposable runner
     -> direct PostgreSQL pool
     -> Google Drive API
```

Cloudflare Workers are control-plane only. Migration work runs on a disposable
GitHub Actions runner and never uses Queue or Hyperdrive; Hyperdrive remains
only on the HTTP control-plane database path.

## Required resources

The Worker configuration expects these existing resources:

- PostgreSQL database reachable from the Worker and GitHub Actions.
- Google OAuth credentials and encrypted token storage configuration.

## First deployment

Create a local `.env` from `.env.example` and fill in the real values. `.env` is deliberately excluded from the release ZIP.

Log in:

```bash
npx wrangler login --use-keyring
```

Then run:

```bash
./scripts/deploy-cloudflare.sh
```

The script first publishes the Worker so it can determine the final `workers.dev` hostname. It then stops before secret upload if the Google OAuth redirect URIs in `.env` do not match that hostname.

Set these two values in `.env` to the printed Worker URL:

```text
ADMIN_GOOGLE_REDIRECT_URI=https://<worker-host>/api/admin/auth/google/callback
DRIVE_ACCOUNT_GOOGLE_REDIRECT_URI=https://<worker-host>/api/admin/accounts/google/callback
```

Add the same two callback URLs to the corresponding Google OAuth client configurations. Then rerun the deployment script.

The script bulk-uploads the Worker secrets, builds the frontend with the Worker URL as `VITE_API_URL`, creates the Pages project when needed, and deploys `dist/` to Pages.

## Required Worker secrets

The script uploads only these secret values:

- `TOKEN_ENCRYPTION_KEY`
- `ADMIN_GOOGLE_CLIENT_ID`
- `ADMIN_GOOGLE_CLIENT_SECRET`
- `ADMIN_GOOGLE_REDIRECT_URI`
- `ADMIN_SESSION_SECRET`
- `DRIVE_ACCOUNT_GOOGLE_CLIENT_ID`
- `DRIVE_ACCOUNT_GOOGLE_CLIENT_SECRET`
- `DRIVE_ACCOUNT_GOOGLE_REDIRECT_URI`

`DATABASE_URL` is supplied to the Node service and the migration workflow as a
GitHub Actions secret. It is never committed or exposed to the Worker.

## Public configuration

`cloudflare/api/wrangler.jsonc` contains non-secret production configuration:

- `FRONTEND_URL=https://college-noticeboard.pages.dev`
- `ALLOWED_ORIGINS=https://college-noticeboard.pages.dev`
- `GOOGLE_DRIVE_HTTP2=true`
- `NODE_ENV=production`

## Migration execution

Creating a migration writes durable PostgreSQL state. The scheduler acquires a
database lease, claims fenced items with bounded adaptive concurrency, and
retries due work. Stale leases are recovered on restart. SIGTERM/SIGINT waits
for active work and releases the lease. `schema_migrations` applies additive
SQL migrations before the scheduler starts.

## Validation

Static validation:

```bash
./scripts/verify-final.sh
```

Full development validation:

```bash
npm install
npm run lint
npm run build
npm test

cd cloudflare/api
npm install
npx wrangler types
npx tsc --noEmit
npm test
npx wrangler deploy --dry-run
```

Do not run the Node integration test suite against a production database without understanding its fixtures and cleanup behavior.

## Security

Never commit or package:

- `.env`
- `.dev.vars`
- OAuth client secrets
- Google refresh tokens
- database passwords
- encryption keys

Cloudflare recommends Wrangler secrets for sensitive Worker configuration rather than storing secrets in the Wrangler configuration or source.
