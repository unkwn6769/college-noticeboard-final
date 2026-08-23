import { pool } from "../db/database.js";
import { syncDepartment } from "./syncDepartment.js";
import { downloadCollegeFile } from "../storage/college.js";
import { uploadBufferTo9Drive } from "../storage/nineDrive.js";

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

function isCollegeNotFoundError(error) {
  return (
    error?.code === "COLLEGE_FILE_NOT_FOUND" ||
    error?.status === 404
  );
}

function isCollegeHttpError(error) {
  return (
    error?.code === "COLLEGE_HTTP_ERROR" ||
    (typeof error?.status === "number" && error.status >= 400)
  );
}

async function syncFileTo9Drive(resource) {
  // Never create a duplicate 9Drive object for an already-synced
  // resource that still has a valid storage key.
  if (
    resource.storage_provider === "google_drive" &&
    resource.storage_status === "synced" &&
    resource.storage_key
  ) {
    console.log(
      `[${resource.id}] STORAGE ALREADY SYNCED → ${resource.storage_key}`
    );

    return {
      success: true,
      status: "already_synced",
    };
  }

  try {
    const buffer = await downloadCollegeFile(resource);

    // Never upload a corrupt/incomplete download.
    if (
      resource.size !== null &&
      buffer.length !== Number(resource.size)
    ) {
      const error = new Error(
        `Size mismatch: expected ${resource.size}, got ${buffer.length}`
      );

      error.code = "COLLEGE_SIZE_MISMATCH";

      throw error;
    }

    const storageKey = await uploadBufferTo9Drive(
      resource,
      buffer
    );

    await pool.query(
      `
      UPDATE resources
      SET
        storage_provider = 'google_drive',
        storage_key = $1,
        storage_status = 'synced',
        storage_error = NULL,
        is_available = TRUE,
        updated_at = NOW()
      WHERE id = $2
      `,
      [storageKey, resource.id]
    );

    console.log(
      `[${resource.id}] STORAGE SYNCED → ${storageKey}`
    );

    return {
      success: true,
      status: "synced",
    };
  } catch (error) {
    const message = getErrorMessage(error);

    /*
     * A confirmed 404 means the source server cannot currently
     * serve the file. The database record is retained, but the
     * resource is marked unavailable.
     */
    if (isCollegeNotFoundError(error)) {
      await pool.query(
        `
        UPDATE resources
        SET
          is_available = FALSE,
          crawl_status = 'http_error',
          storage_provider = NULL,
          storage_key = NULL,
          storage_status = 'failed',
          storage_error = $2,
          updated_at = NOW()
        WHERE id = $1
        `,
        [resource.id, "source_404"]
      );

      console.error(
        `[${resource.id}] SOURCE 404 → marked unavailable`
      );

      return {
        success: false,
        status: "source_404",
      };
    }

    /*
     * Other college HTTP failures are not proof that the source
     * file is gone, so keep the resource available.
     */
    if (isCollegeHttpError(error)) {
      await pool.query(
        `
        UPDATE resources
        SET
          crawl_status = 'http_error',
          storage_provider = NULL,
          storage_key = NULL,
          storage_status = 'failed',
          storage_error = $2,
          updated_at = NOW()
        WHERE id = $1
        `,
        [resource.id, message]
      );

      console.error(
        `[${resource.id}] COLLEGE HTTP ERROR → ${message}`
      );

      return {
        success: false,
        status: "http_error",
      };
    }

    /*
     * Network failures, timeouts, size mismatches, and 9Drive
     * failures must not make the source resource unavailable.
     */
    const storageError =
      error?.code === "COLLEGE_SIZE_MISMATCH"
        ? "size_mismatch"
        : message;

    await pool.query(
      `
      UPDATE resources
      SET
        storage_provider = NULL,
        storage_key = NULL,
        storage_status = 'failed',
        storage_error = $2,
        updated_at = NOW()
      WHERE id = $1
      `,
      [resource.id, storageError]
    );

    console.error(
      `[${resource.id}] STORAGE SYNC FAILED: ${message}`
    );

    return {
      success: false,
      status: "failed",
    };
  }
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
            await syncFileTo9Drive(resource);

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