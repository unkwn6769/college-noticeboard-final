import { pool } from "../db/database.js";
import { syncDepartment } from "./syncDepartment.js";
import { syncFileToGoogleDrive } from "./storageSync.js";

const departments = [
  "civil-noticeboard",
  "cse-noticeboard",
  "cseaiml-noticeboard",
  "csecs-noticeboard",
  "cseds-noticeboard",
  "csit-noticeboard",
  "ece-noticeboard",
  "eee-noticeboard",
  "eie-noticeboard",
  "et-noticeboard",
  "exams-noticeboard",
  "gen-noticeboard",
  "hns-noticeboard",
  "it-noticeboard",
  "mech-noticeboard",
];

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}



async function main() {
  const startedAt = Date.now();

  const runResult = await pool.query(
    `
    INSERT INTO sync_runs (
      status
    )
    VALUES ('running')
    RETURNING id
    `
  );

  const syncRunId = runResult.rows[0].id;

  console.log("");
  console.log("==========================================");
  console.log("      COLLEGE NOTICEBOARD SYNC");
  console.log("==========================================");
  console.log(`Sync run ID: ${syncRunId}`);
  console.log(`Departments: ${departments.length}`);
  console.log("");

  const results = [];

  let totalStorageSynced = 0;
  let totalStorageAlreadySynced = 0;
  let totalStorageFailed = 0;
  let totalSource404 = 0;
  let totalHttpErrors = 0;
  let totalFetchErrors = 0;

  try {
    /*
     * Departments are intentionally processed sequentially.
     * This protects the college IIS server from a large burst
     * of simultaneous requests.
     */
    for (const slug of departments) {
      const departmentStartedAt = Date.now();

      console.log("------------------------------------------");
      console.log(`Starting: ${slug}`);
      console.log("------------------------------------------");

      try {
        const result = await syncDepartment(
          slug,
          syncRunId
        );

        const storageQueue = result.storageQueue ?? [];

        console.log(
          `Storage queue for ${slug}: ${storageQueue.length} file(s)`
        );

        let storageSynced = 0;
        let storageAlreadySynced = 0;
        let storageFailed = 0;
        let source404 = 0;

        for (const resource of storageQueue) {
          const storageResult =
            await syncFileToGoogleDrive(resource);

          if (storageResult.success) {
            if (
              storageResult.status === "already_synced"
            ) {
              storageAlreadySynced++;
            } else {
              storageSynced++;
            }
          } else {
            storageFailed++;

            if (
              storageResult.status === "source_404"
            ) {
              source404++;
            }
          }
        }

        totalStorageSynced += storageSynced;
        totalStorageAlreadySynced +=
          storageAlreadySynced;
        totalStorageFailed += storageFailed;
        totalSource404 += source404;

        totalHttpErrors +=
          result.httpErrors || 0;

        totalFetchErrors +=
          result.fetchErrors || 0;

        const duration =
          (Date.now() - departmentStartedAt) / 1000;

        results.push({
          ...result,
          duration,
          storageQueue: storageQueue.length,
          storageSynced,
          storageAlreadySynced,
          storageFailed,
          source404,
          status: "completed",
        });

        console.log(
          `Storage: ${storageSynced} synced, ` +
          `${storageAlreadySynced} already synced, ` +
          `${storageFailed} failed`
        );

        console.log("");
        console.log(`✓ ${slug}`);
        console.log(
          `  Directories:   ${result.directoriesScanned}`
        );
        console.log(
          `  Resources:     ${result.resourcesFound}`
        );
        console.log(
          `  Added:         ${result.added}`
        );
        console.log(
          `  Updated:       ${result.updated}`
        );
        console.log(
          `  Removed:       ${result.removed}`
        );
        console.log(
          `  HTTP errors:   ${result.httpErrors}`
        );
        console.log(
          `  Fetch errors:  ${result.fetchErrors}`
        );
        console.log(
          `  Storage queue: ${storageQueue.length}`
        );
        console.log(
          `  Storage synced:${storageSynced}`
        );
        console.log(
          `  Source 404:    ${source404}`
        );
        console.log(
          `  Duration:      ${duration.toFixed(2)}s`
        );
        console.log("");
      } catch (error) {
        const duration =
          (Date.now() - departmentStartedAt) / 1000;

        results.push({
          slug,
          status: "failed",
          error: getErrorMessage(error),
          duration,
        });

        console.error("");
        console.error(`✗ ${slug} FAILED`);
        console.error(
          `  ${getErrorMessage(error)}`
        );
        console.error("");
      }
    }

    const completed = results.filter(
      (result) => result.status === "completed"
    );

    const failedDepartments = results.filter(
      (result) => result.status === "failed"
    );

    const totals = completed.reduce(
      (total, result) => {
        total.directories +=
          result.directoriesScanned || 0;

        total.resources +=
          result.resourcesFound || 0;

        total.added += result.added || 0;

        total.updated += result.updated || 0;

        total.removed += result.removed || 0;

        total.httpErrors +=
          result.httpErrors || 0;

        total.fetchErrors +=
          result.fetchErrors || 0;

        return total;
      },
      {
        directories: 0,
        resources: 0,
        added: 0,
        updated: 0,
        removed: 0,
        httpErrors: 0,
        fetchErrors: 0,
      }
    );

    const overallStatus =
      failedDepartments.length > 0
        ? "partial"
        : "completed";

    await pool.query(
      `
      UPDATE sync_runs
      SET
        status = $1,
        finished_at = NOW(),
        resources_found = $2,
        resources_added = $3,
        resources_updated = $4,
        resources_removed = $5,
        errors = $6
      WHERE id = $7
      `,
      [
        overallStatus,
        totals.resources,
        totals.added,
        totals.updated,
        totals.removed,
        totals.httpErrors +
        totals.fetchErrors +
        totalStorageFailed +
        failedDepartments.length,
        syncRunId,
      ]
    );

    const duration =
      (Date.now() - startedAt) / 1000;

    console.log("");
    console.log("");
    console.log("==========================================");
    console.log("          SYNC COMPLETE");
    console.log("==========================================");
    console.log("");
    console.log(
      `Status:                  ${overallStatus}`
    );
    console.log(
      `Sync run ID:             ${syncRunId}`
    );
    console.log(
      `Departments:             ${departments.length}`
    );
    console.log(
      `Completed departments:   ${completed.length}`
    );
    console.log(
      `Failed departments:      ${failedDepartments.length}`
    );
    console.log("");
    console.log(
      `Directories scanned:     ${totals.directories}`
    );
    console.log(
      `Resources found:         ${totals.resources}`
    );
    console.log(
      `Resources added:         ${totals.added}`
    );
    console.log(
      `Resources updated:       ${totals.updated}`
    );
    console.log(
      `Resources removed:       ${totals.removed}`
    );
    console.log(
      `Crawler HTTP errors:     ${totals.httpErrors}`
    );
    console.log(
      `Crawler fetch errors:    ${totals.fetchErrors}`
    );
    console.log("");
    console.log(
      `Storage newly synced:    ${totalStorageSynced}`
    );
    console.log(
      `Storage already synced:  ${totalStorageAlreadySynced}`
    );
    console.log(
      `Storage failures:        ${totalStorageFailed}`
    );
    console.log(
      `Source 404 files:        ${totalSource404}`
    );
    console.log("");
    console.log(
      `Total duration:          ${duration.toFixed(2)}s`
    );
    console.log("");
    console.log("==========================================");
    console.log("");

    if (failedDepartments.length > 0) {
      console.log("FAILED DEPARTMENTS:");
      console.log("");

      for (const result of failedDepartments) {
        console.log(
          `- ${result.slug}: ${result.error}`
        );
      }

      console.log("");
    }
  } catch (error) {
    await pool.query(
      `
      UPDATE sync_runs
      SET
        status = 'failed',
        finished_at = NOW(),
        errors = errors + 1
      WHERE id = $1
      `,
      [syncRunId]
    );

    console.error("");
    console.error("==========================================");
    console.error("          SYNC FAILED");
    console.error("==========================================");
    console.error("");
    console.error(getErrorMessage(error));
    console.error("");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();