import { httpServerHandler } from "cloudflare:node";
import app from "../../../server/app.js";
import { runWithRuntimeContext } from "../../../server/runtimeContext.js";

/*
 * The Worker is a stateless HTTP control plane only. Migration execution is
 * intentionally not implemented here: the GitHub Actions runner starts the
 * Node scheduler against PostgreSQL.
 */
app.listen(3000);
const nodeHandler = httpServerHandler({ port: 3000 });
const nodeFetch = nodeHandler.fetch;

if (!nodeFetch) {
  throw new Error("Cloudflare Node HTTP handler does not expose fetch()");
}

export default {
  ...nodeHandler,
  async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return runWithRuntimeContext(env, () =>
      nodeFetch(
        request as Parameters<typeof nodeFetch>[0],
        env as Parameters<typeof nodeFetch>[1],
        ctx as Parameters<typeof nodeFetch>[2],
      )
    );
  },
} satisfies ExportedHandler;
