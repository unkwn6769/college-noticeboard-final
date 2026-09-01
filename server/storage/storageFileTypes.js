import { pool } from "../db/database.js";
import { aggregateFileTypes } from "./storageFileTypesMath.js";

export async function getStorageFileTypeSummary() {
  const result = await pool.query(`
    SELECT
      name,
      size::text AS size_bytes
    FROM resources
    WHERE type = 'file'
      AND storage_provider = 'google_drive'
      AND storage_status = 'synced'
  `);

  return aggregateFileTypes(result.rows.map((row) => ({
    name: row.name,
    sizeBytes: row.size_bytes,
  })));
}
