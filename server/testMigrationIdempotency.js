import {
  migrateOneItem,
  getMigrationSummary,
} from "./migrationWorker.js";
import { pool } from "./db/database.js";

const migrationId =
  "0808fa41-d9d6-4825-bb89-7e4feab73e16";

try {
  console.log("Before:");
  console.dir(
    await getMigrationSummary(migrationId),
    { depth: null }
  );

  console.log("");
  console.log("Running idempotency test...");
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
    await getMigrationSummary(migrationId),
    { depth: null }
  );
} catch (error) {
  console.error(
    "Idempotency test failed:",
    error instanceof Error
      ? error.message
      : error
  );

  process.exitCode = 1;
} finally {
  await pool.end();
}
