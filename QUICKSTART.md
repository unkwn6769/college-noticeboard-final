# Quick start

1. Copy `.env.example` to `.env` locally and fill in real secrets.
2. Install dependencies at the project root: `npm install`.
3. Run the application backend: `npm run server:dev`.
4. Run the frontend: `npm run dev`.
5. Read `DEPLOYMENT.md` for production deployment.

Cloudflare Worker source lives in `cloudflare/api/`. Its current entrypoint provides health checks and the Queue binding foundation; the existing Express server remains the complete application API.
