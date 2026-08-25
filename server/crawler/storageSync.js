import { pool } from "../db/database.js";
import { downloadCollegeFile } from "../storage/college.js";
import { uploadBufferToGoogleDrive } from "../storage/googleUpload.js";

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

export async function syncFileToGoogleDrive(resource) {
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

    const storageKey = await uploadBufferToGoogleDrive(
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

      return {
        success: false,
        status: "source_404",
      };
    }

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

      return {
        success: false,
        status: "http_error",
      };
    }

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