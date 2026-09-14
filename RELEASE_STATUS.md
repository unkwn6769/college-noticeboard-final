# Release Status

## Architecture

Production target is Cloudflare-only for the application path:

- Cloudflare Pages hosts the Vite/React frontend.
- Cloudflare Worker hosts the Express API through `httpServerHandler`.
- Hyperdrive provides the PostgreSQL connection path.
- Cloudflare Queue drives migration work and administrative source-cleanup retries.
- Google Drive remains the file-storage integration.

The Node server remains available for local development and regression tests.

## Verified before packaging

- Node tests: 57/57 passed.
- Cloudflare tests: 50/50 passed.
- Cloudflare TypeScript check: passed.
- Wrangler dry-run: passed.
- Full Express bundle is below the Workers 64 MiB script-size limit.

## Release checks added

- request-scoped Hyperdrive DB context
- dedicated PostgreSQL sessions for `pool.connect()` transactions
- Queue-backed migration kickoff
- Queue-backed manual source cleanup retry
- target/migration-marker/application-mapping cleanup safety checks
- bulk secret deployment
- direct Pages upload deployment
- secret-free release packaging

## Deployment prerequisite

The Google OAuth clients must contain the final Worker callback URLs before administrator sign-in and Drive-account connection can work in production.
