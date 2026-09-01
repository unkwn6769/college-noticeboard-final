import {
  migrateOneItem,
  getMigrationSummary,
} from "./migrationWorker.js";
import { pool } from "./db/database.js";

const migrationId =
  "a2e32d88-52bf-4a86-8418-97320b16d7a7";

try {
  console.log("Before:");

  console.log(
    await getMigrationSummary(migrationId)
  );

  console.log("");
  console.log("Migrating ONE item...");
  console.log("");

  const result =
    await migrateOneItem(migrationId);

  console.log("");
  console.log("Result:");
  console.dir(result, {
    depth: null,
  });

  console.log("");
  console.log("After:");

  console.dir(
    await getMigrationSummary(
      migrationId
    ),
    {
      depth: null,
    }
  );
} catch (error) {
  console.error("");
  console.error(
    "Migration test failed:",
    error instanceof Error
      ? error.message
      : error
  );

  process.exitCode = 1;
} finally {
  await pool.end();
}
