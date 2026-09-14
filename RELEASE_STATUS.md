# Release Status

## Architecture

Production target uses a direct PostgreSQL runner:

- Cloudflare Pages hosts the Vite/React frontend.
- Cloudflare Worker hosts the Express control-plane API.
- GitHub Actions starts disposable migration runners with direct PostgreSQL access.
- Cloudflare Worker, if deployed, is HTTP control-plane only.
- Google Drive remains the file-storage integration.

The Node server remains available for local development and regression tests.

## Verified before packaging

- Server-side copy tests: 11/11 passed.
- Frontend build and lint: passed with existing warnings.
- Cloudflare TypeScript check: passed.
- Full Express bundle is below the Workers 64 MiB script-size limit.

## Release checks added

- additive tracked schema migrations
- durable PostgreSQL scheduler leases and fenced retries
- direct runner workflow
- target/migration-marker/application-mapping cleanup safety checks
- bulk secret deployment
- direct Pages upload deployment
- secret-free release packaging

## Deployment prerequisite

The Google OAuth clients must contain the final Worker callback URLs before administrator sign-in and Drive-account connection can work in production.
