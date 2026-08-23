import { pool } from "../db/database.js";
import { syncDepartment } from "./syncDepartment.js";

async function main() {
  const result = await pool.query(
    `
    INSERT INTO sync_runs (status)
    VALUES ('running')
    RETURNING id
    `
  );

  const syncRunId = result.rows[0].id;

  try {
    const syncResult = await syncDepartment(
      "csit-noticeboard",
      syncRunId
    );

    await pool.query(
      `
      UPDATE sync_runs
      SET
        status = 'completed',
        finished_at = NOW(),
        resources_found = $1,
        resources_added = $2,
        resources_updated = $3,
        resources_removed = $4,
        errors = $5
      WHERE id = $6
      `,
      [
        syncResult.resourcesFound,
        syncResult.added,
        syncResult.updated,
        syncResult.removed,
        syncResult.httpErrors +
          syncResult.fetchErrors,
        syncRunId,
      ]
    );

    console.log("");
    console.log("========== CSIT TEST ==========");
    console.log(`Directories: ${syncResult.directoriesScanned}`);
    console.log(`Resources:   ${syncResult.resourcesFound}`);
    console.log(`Added:       ${syncResult.added}`);
    console.log(`Updated:     ${syncResult.updated}`);
    console.log(`Removed:     ${syncResult.removed}`);
    console.log(`HTTP errors: ${syncResult.httpErrors}`);
    console.log(`Fetch errors:${syncResult.fetchErrors}`);
    console.log(`Sync run:    ${syncRunId}`);
    console.log("===============================");
    console.log("");
  } catch (error) {
    await pool.query(
      `
      UPDATE sync_runs
      SET
        status = 'failed',
        finished_at = NOW()
      WHERE id = $1
      `,
      [syncRunId]
    );

    console.error("CSIT TEST FAILED:");
    console.error(error);

    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();