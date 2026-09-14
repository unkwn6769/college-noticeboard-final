# College Noticeboard — Cloudflare Deployment

This release uses a Cloudflare-native application path:

```text
Browser
  -> Cloudflare Pages (React/Vite)
  -> Cloudflare Worker (Express API)
     -> Hyperdrive -> Supabase/PostgreSQL
     -> Google APIs

Admin migration actions
  -> Cloudflare Queue
  -> same Worker queue consumer
  -> Google Drive / Hyperdrive
```

The Node server remains available for local development and compatibility testing. It is not required as a separate production service for the Cloudflare deployment.

## Cloudflare resources

The Worker configuration expects these existing resources:

- Worker: `college-noticeboard-api`
- Queue: `college-noticeboard-migrations`
- Hyperdrive: `143a18762ebe484186882c4e53d9bee8`
- Pages project: `college-noticeboard`

For a different Cloudflare account, replace the Hyperdrive/Queue resources in `cloudflare/api/wrangler.jsonc` with resources owned by that account.

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

`DATABASE_URL` is not uploaded to the Worker. Worker database access uses Hyperdrive. The Node runtime still uses `DATABASE_URL` locally.

## Public configuration

`cloudflare/api/wrangler.jsonc` contains non-secret production configuration:

- `FRONTEND_URL=https://college-noticeboard.pages.dev`
- `ALLOWED_ORIGINS=https://college-noticeboard.pages.dev`
- `GOOGLE_DRIVE_HTTP2=true`
- `NODE_ENV=production`

## Migration execution

Creating a migration inserts all migration items transactionally, then queues a `migration_kickoff` message. The Worker seeds pending items into Queue batches of up to 100 messages.

Normal queue messages use the existing `{ migrationId, itemId }` contract. Source-cleanup retries use a separate `{ type: "source_cleanup_retry", itemId }` contract.

The migration engine keeps its durable PostgreSQL retry/reconciliation state. Queue retries are only the delivery mechanism. Source cleanup performs the target-file, migration-marker, and application-mapping safety checks before deleting a source.

Cloudflare Queues currently allow up to 100 messages per `sendBatch`, up to 100 messages per consumer batch, and automatic consumer concurrency scaling. Queue operations on Workers Free are subject to the current included-operation quota, so large migrations can exceed a Free-plan daily quota even though the deployment itself is card-free.

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
