import { httpServerHandler } from "cloudflare:node";

import app from "../../../server/app.js";
import { runWithRuntimeContext } from "../../../server/runtimeContext.js";
import { processMigrationItem } from "./migrations/processItem";
import { retrySourceCleanup } from "./migrations/sourceCleanup";
import {
  isMigrationKickoffMessage,
  isNormalMigrationMessage,
  isSourceCleanupMessage,
  seedPendingMigrationItems,
} from "./migrations/queueDispatch";
import { finalizeMigrationIfComplete } from "./migrations/finalizeMigration";

app.listen(3000);

const nodeHandler = httpServerHandler({ port: 3000 });
const nodeFetch = nodeHandler.fetch;

if (!nodeFetch) {
  throw new Error("Cloudflare Node HTTP handler does not expose fetch()");
}

function retryDelaySeconds(delayMs: number | undefined): number {
  const value = Number(delayMs);
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.ceil(value / 1000));
}

export default {
  ...nodeHandler,

  async fetch(request, env, ctx): Promise<Response> {
    return runWithRuntimeContext(env, () =>
      nodeFetch(request, env, ctx),
    );
  },

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (isMigrationKickoffMessage(message.body)) {
          const result = await seedPendingMigrationItems(
            env,
            message.body.migrationId,
          );

          if (result.hasMore) {
            await env.MIGRATION_QUEUE.send({
              type: "migration_kickoff",
              migrationId: message.body.migrationId,
            });
          }

          message.ack();
          continue;
        }

        if (isSourceCleanupMessage(message.body)) {
          const result = await retrySourceCleanup(
            env,
            message.body.itemId,
          );

          if (result.status === "failed") {
            message.retry({ delaySeconds: 60 });
          } else {
            message.ack();
          }

          continue;
        }

        if (!isNormalMigrationMessage(message.body)) {
          throw new Error("Invalid migration queue message");
        }

        const result = await processMigrationItem(
          env,
          message.body,
        );

        switch (result.status) {
          case "retry_later":
          case "retrying":
          case "waiting_for_storage":
          case "reconciling":
            message.retry({
              delaySeconds: retryDelaySeconds(result.delayMs),
            });
            break;

          case "completed":
          case "already_handled": {
            await finalizeMigrationIfComplete(
              env,
              result.migrationId,
            );

            await env.MIGRATION_QUEUE.send({
              type: "source_cleanup_retry",
              itemId: result.itemId,
            });

            message.ack();
            break;
          }

          default:
            message.ack();
            break;
        }

      } catch (error) {
        console.error(
          `Migration queue message ${message.id} failed:`,
          error,
        );

        message.retry({
          delaySeconds: Math.min(
            60,
            Math.max(5, 2 ** Math.min(message.attempts, 6)),
          ),
        });
      }
    }
  },
} satisfies ExportedHandler<Env>;
