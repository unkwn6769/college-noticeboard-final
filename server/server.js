import {
  ensureAdminManagementSchema,
  ensureActivityLogSchema,
  closeDatabase,
} from "./db/database.js";
import { runSchemaMigrations } from "./db/migrate.js";

import { ensureQuotaSnapshotSchema } from "./storage/storageQuota.js";

import {
  startMigrationScheduler,
  stopMigrationScheduler,
} from "./migrationScheduler.js";

import app from "./app.js";

const PORT = Number(process.env.PORT) || 3001;

const httpServer = app.listen(PORT, "0.0.0.0", async () => {
  console.log(
    `Backend running on port ${PORT}`
  );

  try {
    await runSchemaMigrations();
  } catch (error) {
    console.error("Failed to apply schema migrations:", error);
    httpServer.close();
    return;
  }

  try {
    await ensureAdminManagementSchema();
  } catch (error) {
    console.error(
      "Failed to ensure admin management schema:",
      error
    );
  }

  try {
    await ensureActivityLogSchema();
  } catch (error) {
    console.error("Failed to ensure activity log schema:", error);
  }

  try {
    await ensureQuotaSnapshotSchema();
  } catch (error) {
    console.error("Failed to ensure storage quota schema:", error);
  }

  startMigrationScheduler().catch(
    (error) => {
      console.error(
        "Migration scheduler stopped:",
        error
      );
    }
  );
});

let shutdownPromise = null;

async function shutdown(signal) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    console.log(`[SERVER] Received ${signal}; shutting down gracefully`);

    try {
      await stopMigrationScheduler();
    } catch (error) {
      console.error(
        "[SERVER] Failed to stop migration scheduler:",
        error instanceof Error ? error.message : error
      );
    }

    await new Promise((resolve) => {
      httpServer.close(() => resolve());
    });

    try {
      await closeDatabase();
    } catch (error) {
      console.error(
        "[SERVER] Failed to close PostgreSQL pool:",
        error instanceof Error ? error.message : error
      );
    }
  })();

  return shutdownPromise;
}

process.once("SIGINT", () => {
  shutdown("SIGINT")
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("[SERVER] Shutdown failed:", error);
      process.exit(1);
    });
});

process.once("SIGTERM", () => {
  shutdown("SIGTERM")
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("[SERVER] Shutdown failed:", error);
      process.exit(1);
    });
});
