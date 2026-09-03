import express from "express";
import cors from "cors";
import {
  pool,
  ensureMigrationPerformanceIndexes,
  ensureMigrationSafetySchema,
  ensureAdminManagementSchema,
  ensureActivityLogSchema,
} from "./db/database.js";
import contentDisposition from "content-disposition";
import crypto from "node:crypto";

import {
  getGoogleAuthorizationUrl,
  handleGoogleCallback,
  getAdminFromSession,
  deleteAdminSession,
  parseSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  requireAdmin,
  requireOwner,
} from "./adminAuth.js";
import {
  getConnectedGoogleDriveAccounts,
  getGoogleDriveClientForAccount,
} from "./storage/googleClient.js";
import {
  getStorageSummary,
  ensureQuotaSnapshotSchema,
} from "./storage/storageQuota.js";
import { getStorageFileTypeSummary } from "./storage/storageFileTypes.js";
import { getStorageHealth } from "./storage/storageHealth.js";
import { listRecycleBin, restoreRecycleBinFile, permanentlyDeleteRecycleBinFile } from "./recycleBin.js";
import { getSourceRetentionVisibility, normalizeSourceRetentionFilters } from "./sourceRetention.js";
import { runNetworkDiagnostic } from "./networkDiagnostic.js";
import { getFileTypeExtensions } from "./storage/storageFileTypesMath.js";
import {
  buildDriveFileSearchWhere,
  normalizeDriveFileSearchFilters,
} from "./driveFileSearch.js";
import { ACTIVITY_EVENT_TYPES, getAdminActivity, logAdminActivity } from "./activityLog.js";
import {
  getDriveAccountAuthorizationUrl,
  handleDriveAccountCallback,
} from "./driveAccountOAuth.js";
import {
  startMigrationScheduler,
  stopMigrationScheduler,
} from "./migrationScheduler.js";
import { retryFailedSourceDeletion } from "./migrationWorker.js";

const app = express();

const allowedOrigins = [
  "http://localhost:5173",
  "https://college-noticeboard.onrender.com",
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser requests such as curl.
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error("CORS origin not allowed")
      );
    },
    credentials: true,
  })
);

app.use(express.json());

app.get(
  "/api/admin/network-diagnostic",
  requireAdmin,
  async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      return res.json(await runNetworkDiagnostic());
    } catch (error) {
      console.error("Admin network diagnostic failed:", error);
      return res.status(502).json({
        error: "Network diagnostic failed",
      });
    }
  }
);



const PORT = Number(process.env.PORT) || 3001;

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

// "/api/admin/activity"
app.get(
  "/api/admin/activity",
  requireAdmin,
  async (req, res) => {
    try {
      const page = Number(req.query.page ?? 1);
      const pageSize = Number(req.query.pageSize ?? 50);
      const eventType = String(req.query.eventType || "").trim();

      if (!Number.isInteger(page) || page < 1) {
        return res.status(400).json({ error: "Page must be a positive integer" });
      }

      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        return res.status(400).json({ error: "Page size must be an integer between 1 and 100" });
      }

      return res.json(await getAdminActivity({ page, pageSize, eventType }));
    } catch (error) {
      console.error("Admin activity log lookup failed:", error);
      return res.status(500).json({ error: "Failed to load activity log" });
    }
  }
);


// "/api/admin/source-retention"
app.get(
  "/api/admin/source-retention",
  requireAdmin,
  async (req, res) => {
    try {
      const filters = normalizeSourceRetentionFilters(req.query);
      const allowedItemStatuses = new Set([
        "pending",
        "running",
        "completed",
        "failed",
        "reconciling",
        "reconciliation_expired",
        "ambiguous_identity",
        "cancelled",
      ]);

      if (filters.itemStatus && !allowedItemStatuses.has(filters.itemStatus)) {
        return res.status(400).json({ error: "Invalid item status" });
      }

      return res.json(await getSourceRetentionVisibility(filters));
    } catch (error) {
      console.error("Admin source-retention lookup failed:", error);
      return res.status(500).json({ error: "Failed to load source-retention status" });
    }
  }
);

// "/api/admin/source-retention/:itemId/retry"
app.post(
  "/api/admin/source-retention/:itemId/retry",
  requireOwner,
  async (req, res) => {
    try {
      const itemId = String(req.params.itemId || "").trim();
      if (!itemId) {
        return res.status(400).json({ error: "Migration item id is required" });
      }

      const result = await retryFailedSourceDeletion(itemId);

      if (result.status === "skipped") {
        return res.status(409).json({
          error: "This item is not currently eligible for source cleanup retry",
          result,
        });
      }

      await logAdminActivity({
        req,
        admin: req.admin,
        eventType: ACTIVITY_EVENT_TYPES.SOURCE_CLEANUP_RETRY,
        entityType: "migration_item",
        entityId: itemId,
        description: `Retried source cleanup for migration item ${itemId}`,
        metadata: { result },
      });

      return res.json({ result });
    } catch (error) {
      console.error("Admin source cleanup retry failed:", error);
      return res.status(error?.status || 500).json({
        error: error?.message || "Failed to retry source cleanup",
      });
    }
  }
);

// "/api/admin/recycle-bin"
app.get(
  "/api/admin/recycle-bin",
  requireAdmin,
  async (req, res) => {
    try {
      const accountId = String(req.query.accountId || "").trim();
      const result = await listRecycleBin({ accountId });
      return res.json(result);
    } catch (error) {
      console.error("Admin recycle bin lookup failed:", error);
      return res.status(500).json({ error: "Failed to load recycle bin" });
    }
  }
);

// "/api/admin/recycle-bin/:fileId/restore"
app.post(
  "/api/admin/recycle-bin/:fileId/restore",
  requireAdmin,
  async (req, res) => {
    try {
      const fileId = String(req.params.fileId || "").trim();
      if (!fileId) return res.status(400).json({ error: "Drive file id is required" });

      const file = await restoreRecycleBinFile(fileId);

      await logAdminActivity({
        req,
        admin: req.admin,
        eventType: ACTIVITY_EVENT_TYPES.DRIVE_FILE_RESTORED,
        entityType: "drive_file",
        entityId: fileId,
        description: `Restored Drive file ${file.name}`,
        metadata: { fileId, accountEmail: file.accountEmail },
      });

      return res.json({ file });
    } catch (error) {
      console.error("Admin recycle bin restore failed:", error);
      return res.status(error?.status || 500).json({ error: error?.message || "Failed to restore file" });
    }
  }
);

// "/api/admin/recycle-bin/:fileId"
app.delete(
  "/api/admin/recycle-bin/:fileId",
  requireOwner,
  async (req, res) => {
    try {
      const fileId = String(req.params.fileId || "").trim();
      if (!fileId) return res.status(400).json({ error: "Drive file id is required" });

      const result = await permanentlyDeleteRecycleBinFile(fileId);

      await logAdminActivity({
        req,
        admin: req.admin,
        eventType: ACTIVITY_EVENT_TYPES.DRIVE_FILE_PERMANENTLY_DELETED,
        entityType: "drive_file",
        entityId: fileId,
        description: `Permanently deleted Drive file ${fileId}`,
        metadata: result,
      });

      return res.json(result);
    } catch (error) {
      console.error("Admin recycle bin permanent delete failed:", error);
      return res.status(error?.status || 500).json({ error: error?.message || "Failed to permanently delete file" });
    }
  }
);

// "/api/admin/storage/summary"
app.get(
  "/api/admin/storage/summary",
  requireAdmin,
  async (req, res) => {
    try {
      const summary = await getStorageSummary({ refresh: false });
      return res.json({ summary });
    } catch (error) {
      console.error("Admin storage summary failed:", error);
      return res.status(500).json({ error: "Failed to load combined storage summary" });
    }
  }
);

// "/api/admin/storage/file-types"
app.get(
  "/api/admin/storage/file-types",
  requireAdmin,
  async (req, res) => {
    try {
      const summary = await getStorageFileTypeSummary();
      return res.json({ summary });
    } catch (error) {
      console.error("Admin storage file-type summary failed:", error);
      return res.status(500).json({ error: "Failed to load storage usage by file type" });
    }
  }
);

// Actual managed Drive files for a selected file-type category.
app.get(
  "/api/admin/storage/file-types/files",
  requireAdmin,
  async (req, res) => {
    try {
      const typeKey = String(req.query.type || "").trim().toLowerCase();
      const requestedPage = Number(req.query.page ?? 1);
      const requestedPageSize = Number(req.query.pageSize ?? 50);

      if (!typeKey) {
        return res.status(400).json({ error: "File type is required" });
      }

      if (!Number.isInteger(requestedPage) || requestedPage < 1) {
        return res.status(400).json({ error: "Page must be a positive integer" });
      }

      if (
        !Number.isInteger(requestedPageSize) ||
        requestedPageSize < 1 ||
        requestedPageSize > 100
      ) {
        return res.status(400).json({
          error: "Page size must be an integer between 1 and 100",
        });
      }

      const descriptor = getFileTypeExtensions(typeKey);

      if (!descriptor) {
        return res.status(400).json({ error: "Unknown file type" });
      }

      let typePredicate;
      let predicateParams = [];

      if (descriptor.mode === "extensions") {
        typePredicate = `LOWER(REGEXP_REPLACE(SPLIT_PART(r.name, '?', 1), '^.*\\.([a-z0-9]{1,15})$', '\\1')) = ANY($1::text[])`;
        predicateParams = [descriptor.extensions];
      } else if (descriptor.mode === "unknown") {
        typePredicate = `r.name !~ '\\.[a-z0-9]{1,15}$'`;
      } else {
        typePredicate = `
          r.name ~ '\\.[a-z0-9]{1,15}$'
          AND LOWER(REGEXP_REPLACE(SPLIT_PART(r.name, '?', 1), '^.*\\.([a-z0-9]{1,15})$', '\\1')) <> ALL($1::text[])
        `;
        predicateParams = [descriptor.extensions];
      }

      const countResult = await pool.query(
        `
        SELECT COUNT(*)::bigint AS total
        FROM resources r
        INNER JOIN google_drive_file_accounts f
          ON f.file_id = r.storage_key
        WHERE r.type = 'file'
          AND r.storage_provider = 'google_drive'
          AND r.storage_status = 'synced'
          AND ${typePredicate}
        `,
        predicateParams
      );

      const total = Number(countResult.rows[0].total);
      const totalPages = Math.max(1, Math.ceil(total / requestedPageSize));
      const page = Math.min(requestedPage, totalPages);
      const offset = (page - 1) * requestedPageSize;
      const params = [...predicateParams, requestedPageSize, offset];
      const limitIndex = predicateParams.length + 1;
      const offsetIndex = predicateParams.length + 2;
      const filesResult = await pool.query(
        `
        SELECT
          f.file_id,
          r.id,
          r.name,
          r.size,
          r.source_modified_at,
          r.path,
          r.is_available,
          r.storage_status,
          a.id AS account_id,
          a.email AS account_email
        FROM resources r
        INNER JOIN google_drive_file_accounts f
          ON f.file_id = r.storage_key
        INNER JOIN google_drive_accounts a
          ON a.id = f.account_id
        WHERE r.type = 'file'
          AND r.storage_provider = 'google_drive'
          AND r.storage_status = 'synced'
          AND ${typePredicate}
        ORDER BY LOWER(r.name), r.id, f.file_id
        LIMIT $${limitIndex}
        OFFSET $${offsetIndex}
        `,
        params
      );

      return res.json({
        files: filesResult.rows.map((row) => ({
          id: row.id.toString(),
          fileId: row.file_id,
          name: row.name,
          sizeBytes: row.size == null ? null : row.size.toString(),
          sourceModifiedAt: row.source_modified_at,
          path: row.path,
          isAvailable: row.is_available,
          storageStatus: row.storage_status,
          accountId: row.account_id,
          accountEmail: row.account_email,
        })),
        pagination: {
          page,
          pageSize: requestedPageSize,
          total,
          totalPages,
        },
      });
    } catch (error) {
      console.error("Admin storage file-type files failed:", error);
      return res.status(500).json({ error: "Failed to load files for this type" });
    }
  }
);

// "/api/admin/storage/health"
app.get(
  "/api/admin/storage/health",
  requireAdmin,
  async (req, res) => {
    try {
      return res.json({ health: await getStorageHealth() });
    } catch (error) {
      console.error("Admin storage health failed:", error);
      return res.status(500).json({ error: "Failed to load storage health" });
    }
  }
);

// "/api/admin/storage/refresh"
app.post(
  "/api/admin/storage/refresh",
  requireAdmin,
  async (req, res) => {
    try {
      const summary = await getStorageSummary({ refresh: true });
      await logAdminActivity({
        req,
        admin: req.admin,
        eventType: ACTIVITY_EVENT_TYPES.STORAGE_REFRESHED,
        entityType: "storage",
        description: "Refreshed connected Google Drive storage quotas",
        metadata: {
          accountCount: summary?.accounts?.length ?? null,
          totalCapacityBytes: summary?.totalCapacityBytes ?? null,
          totalUsedBytes: summary?.totalUsedBytes ?? null,
        },
      });
      return res.json({ summary });
    } catch (error) {
      console.error("Admin storage refresh failed:", error);
      return res.status(500).json({ error: "Failed to refresh Google Drive storage" });
    }
  }
);

// "/api/admin/accounts"
app.get(
  "/api/admin/accounts",
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          a.id,
          a.email,
          a.status,
          a.created_at,
          a.updated_at,
          COUNT(f.file_id)::bigint AS file_count
        FROM google_drive_accounts a
        LEFT JOIN google_drive_file_accounts f
          ON f.account_id = a.id
        GROUP BY
          a.id,
          a.email,
          a.status,
          a.created_at,
          a.updated_at
        ORDER BY a.email
      `);

      const dbAccounts = result.rows;

      const connected =
        await getConnectedGoogleDriveAccounts();

      const liveById = new Map(
        connected.map(({ account, drive }) => [
          account.connected_account_id,
          { account, drive },
        ])
      );

      const accounts = [];

      for (const row of dbAccounts) {
        const live = liveById.get(row.id);

        let quota = null;

        if (live) {
          try {
            const about =
              await live.drive.about.get({
                fields: "storageQuota,user",
              });

            const storageQuota =
              about.data.storageQuota;

            if (
              storageQuota?.limit &&
              storageQuota?.usage
            ) {
              const limit = BigInt(
                storageQuota.limit
              );

              const usage = BigInt(
                storageQuota.usage
              );

              quota = {
                limitBytes: limit.toString(),
                usageBytes: usage.toString(),
                freeBytes: (
                  limit - usage
                ).toString(),
              };
            }
          } catch (error) {
            console.error(
              `Failed to read quota for ${row.email}:`,
              error instanceof Error
                ? error.message
                : error
            );
          }
        }

        accounts.push({
          id: row.id,
          email: row.email,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          fileCount: Number(row.file_count),
          quota,
        });
      }

      res.json({ accounts });
    } catch (error) {
      console.error(
        "Admin Google account listing failed:",
        error
      );

      res.status(500).json({
        error: "Failed to load Google Drive accounts",
      });
    }
  }
);

// Live Google Drive folder browser. Unlike the application-mapped inventory
// endpoint below, this endpoint scans the selected Drive folder directly.
app.get(
  "/api/admin/accounts/:id/drive-browse",
  requireAdmin,
  async (req, res) => {
    try {
      const accountId = String(req.params.id || "").trim();
      const requestedPage = Number(req.query.page ?? 1);
      const requestedPageSize = Number(req.query.pageSize ?? 50);
      const folderId = String(req.query.folderId ?? "root").trim() || "root";

      if (!accountId) {
        return res.status(400).json({ error: "Google Drive account id is required" });
      }
      if (!Number.isInteger(requestedPage) || requestedPage < 1) {
        return res.status(400).json({ error: "Page must be a positive integer" });
      }
      if (!Number.isInteger(requestedPageSize) || requestedPageSize < 1 || requestedPageSize > 100) {
        return res.status(400).json({ error: "Page size must be an integer between 1 and 100" });
      }

      const accountResult = await pool.query(
        `SELECT id, email, status, created_at, updated_at
         FROM google_drive_accounts
         WHERE id = $1
         LIMIT 1`,
        [accountId]
      );

      if (accountResult.rows.length === 0) {
        return res.status(404).json({ error: "Google Drive account not found" });
      }

      const account = accountResult.rows[0];
      if (account.status !== "connected") {
        return res.status(409).json({ error: "Google Drive account is not connected" });
      }

      const connected = await getConnectedGoogleDriveAccounts();
      const entry = connected.find(
        ({ account: candidate }) => String(candidate.connected_account_id) === accountId
      );

      if (!entry) {
        return res.status(409).json({ error: "Google Drive account could not be authorized" });
      }

      const drive = entry.drive;
      const pageToken = String(req.query.pageToken ?? "").trim() || undefined;
      const response = await drive.files.list({
        q: `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false`,
        pageSize: requestedPageSize,
        pageToken,
        orderBy: "folder,name",
        fields:
          "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,parents,trashed)",
        spaces: "drive",
      });

      const driveFiles = response.data.files ?? [];
      const fileIds = driveFiles.filter((file) =>
        file.mimeType !== "application/vnd.google-apps.folder"
      ).map((file) => String(file.id));

      const resourcesResult = fileIds.length
        ? await pool.query(
            `SELECT
               r.storage_key,
               r.path,
               r.name AS resource_name,
               r.storage_status,
               r.is_available,
               d.slug AS department
             FROM resources r
             LEFT JOIN departments d ON d.id = r.department_id
             WHERE r.storage_provider = 'google_drive'
               AND r.storage_key = ANY($1::text[])`,
            [fileIds]
          )
        : { rows: [] };

      const resourceById = new Map(
        resourcesResult.rows.map((row) => [String(row.storage_key), row])
      );

      const items = driveFiles.map((file) => {
        const resource = resourceById.get(String(file.id));
        const isFolder = file.mimeType === "application/vnd.google-apps.folder";
        return {
          id: String(file.id),
          fileId: String(file.id),
          name: file.name ?? "Untitled",
          mimeType: file.mimeType ?? null,
          sizeBytes: file.size ?? null,
          sourceModifiedAt: file.modifiedTime ?? null,
          webViewLink: file.webViewLink ?? null,
          isFolder,
          parentFolderId: folderId,
          path: resource?.path ?? null,
          storageStatus: resource?.storage_status ?? null,
          isAvailable: resource?.is_available ?? null,
          department: resource?.department ?? null,
          managed: Boolean(resource),
          resourceName: resource?.resource_name ?? null,
        };
      });

      let parentFolderId = null;
      let currentFolder = null;
      if (folderId !== "root") {
        const currentResponse = await drive.files.get({
          fileId: folderId,
          fields: "id,name,parents,mimeType,webViewLink",
        });
        currentFolder = currentResponse.data;
        parentFolderId = currentFolder?.parents?.[0] ?? "root";
      }

      res.json({
        account: {
          id: account.id,
          email: account.email,
          status: account.status,
          createdAt: account.created_at,
          updatedAt: account.updated_at,
        },
        folder: {
          id: folderId,
          name: currentFolder?.name ?? "Drive root",
          parentId: parentFolderId,
        },
        files: items,
        nextPageToken: response.data.nextPageToken ?? null,
      });
    } catch (error) {
      console.error("Admin live Drive browse failed:", error);
      res.status(500).json({ error: "Failed to scan this Google Drive folder" });
    }
  }
);

// "/api/admin/accounts/:id/files"
app.get(
  "/api/admin/accounts/:id/files",
  requireAdmin,
  async (req, res) => {
    try {
      const accountId = String(req.params.id || "").trim();
      const requestedPage = Number(req.query.page ?? 1);
      const requestedPageSize = Number(
        req.query.pageSize ?? req.query.limit ?? 50
      );
      const search = String(req.query.q ?? "").trim();
      const extension = String(req.query.extension ?? "").trim().toLowerCase();
      const fileType = String(req.query.fileType ?? "").trim().toLowerCase();
      const status = String(req.query.status ?? "").trim().toLowerCase();
      const availability = String(req.query.available ?? "").trim().toLowerCase();
      const currentPath = String(req.query.path ?? "").trim();

      if (!accountId) {
        return res.status(400).json({
          error: "Google Drive account id is required",
        });
      }

      if (
        !Number.isInteger(requestedPage) ||
        requestedPage < 1
      ) {
        return res.status(400).json({
          error: "Page must be a positive integer",
        });
      }

      if (
        !Number.isInteger(requestedPageSize) ||
        requestedPageSize < 1 ||
        requestedPageSize > 100
      ) {
        return res.status(400).json({
          error: "Page size must be an integer between 1 and 100",
        });
      }

      const accountResult = await pool.query(
        `
        SELECT
          id,
          email,
          status,
          created_at,
          updated_at
        FROM google_drive_accounts
        WHERE id = $1
        LIMIT 1
        `,
        [accountId]
      );

      if (accountResult.rows.length === 0) {
        return res.status(404).json({
          error: "Google Drive account not found",
        });
      }

      const account = accountResult.rows[0];

      const filters = [accountId];
      const where = ["f.account_id = $1", "r.type = 'file'"];

      if (currentPath) {
        filters.push(currentPath);
        where.push(`COALESCE(r.parent_path, '') = $${filters.length}`);
      }

      if (search) {
        const escaped = search
          .replaceAll('\\', '\\\\')
          .replaceAll('%', '\\%')
          .replaceAll('_', '\\_');
        filters.push(`%${escaped}%`);
        const param = `$${filters.length}`;
        where.push(`(r.name ILIKE ${param} ESCAPE '\\' OR r.path ILIKE ${param} ESCAPE '\\' OR f.file_id ILIKE ${param} ESCAPE '\\')`);
      }

      const fileTypePatterns = {
        pdf: ['pdf'],
        documents: ['doc', 'docx', 'rtf', 'odt', 'txt'],
        spreadsheets: ['xls', 'xlsx', 'csv', 'ods'],
        presentations: ['ppt', 'pptx', 'odp'],
        images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'],
        video: ['mp4', 'mov', 'avi', 'mkv', 'webm'],
        audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac'],
        archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'],
        code: ['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'json', 'xml', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'sql'],
        text: ['md', 'log'],
      };

      if (fileType) {
        if (fileType === 'no_extension') {
          where.push(`LOWER(r.name) NOT LIKE '%.%'`);
        } else if (fileType === 'other') {
          const allKnown = Object.values(fileTypePatterns).flat();
          const pattern = allKnown.map((value) => `\\.${value}$`).join('|');
          where.push(`LOWER(r.name) !~ '(${pattern})'`);
        } else if (fileTypePatterns[fileType]) {
          const pattern = fileTypePatterns[fileType].map((value) => `\\.${value}$`).join('|');
          where.push(`LOWER(r.name) ~ '(${pattern})'`);
        } else {
          return res.status(400).json({ error: "Invalid file type filter" });
        }
      } else if (extension) {
        filters.push(extension);
        const param = `$${filters.length}`;
        if (extension === 'no_extension') {
          where.push(`r.name NOT LIKE '%.%'`);
        } else if (/^[a-z0-9][a-z0-9+_-]{0,15}$/.test(extension)) {
          where.push(`LOWER(r.name) LIKE '%.' || ${param}`);
        } else {
          return res.status(400).json({ error: "Invalid file extension filter" });
        }
      }

      if (status) {
        const allowedStatuses = new Set(['pending', 'uploading', 'synced', 'failed']);
        if (!allowedStatuses.has(status)) {
          return res.status(400).json({ error: "Invalid storage status filter" });
        }
        filters.push(status);
        where.push(`r.storage_status = $${filters.length}`);
      }

      if (availability) {
        if (availability !== 'available' && availability !== 'unavailable') {
          return res.status(400).json({ error: "Invalid availability filter" });
        }
        where.push(`r.is_available = ${availability === 'available' ? 'TRUE' : 'FALSE'}`);
      }

      const whereSql = where.join('\n          AND ');

      const countResult = await pool.query(
        `
        SELECT COUNT(*)::bigint AS total
        FROM google_drive_file_accounts f
        INNER JOIN resources r
          ON r.storage_key = f.file_id
        WHERE
          ${whereSql}
        `,
        filters
      );

      const total = Number(countResult.rows[0].total);
      const totalPages = Math.max(1, Math.ceil(total / requestedPageSize));
      const page = Math.min(requestedPage, totalPages);
      const offset = (page - 1) * requestedPageSize;

      const queryValues = [...filters, requestedPageSize, offset];
      const filesResult = await pool.query(
        `
        SELECT
          f.file_id,
          r.name,
          r.size,
          r.source_modified_at,
          r.path,
          r.storage_provider,
          r.storage_status,
          r.is_available,
          d.slug AS department
        FROM google_drive_file_accounts f
        INNER JOIN resources r
          ON r.storage_key = f.file_id
        LEFT JOIN departments d
          ON d.id = r.department_id
        WHERE
          ${whereSql}
        ORDER BY
          LOWER(r.name),
          r.id,
          f.file_id
        LIMIT $${queryValues.length - 1}
        OFFSET $${queryValues.length}
        `,
        queryValues
      );

      const folderParams = [currentPath];
      const folderWhere = currentPath
        ? `r.type = 'folder' AND r.parent_path = $1`
        : `r.type = 'folder' AND (r.parent_path IS NULL OR r.parent_path = '')`;

      const foldersResult = await pool.query(
        `
        SELECT path, name
        FROM resources r
        WHERE ${folderWhere}
        ORDER BY LOWER(name), path
        `,
        currentPath ? folderParams : []
      );

      const parentPath = (() => {
        if (!currentPath) return "";
        const normalized = currentPath.replace(/\/$/, "");
        const slash = normalized.lastIndexOf("/");
        return slash > 0 ? `${normalized.slice(0, slash)}/` : "";
      })();

      return res.json({
        account: {
          id: account.id,
          email: account.email,
          status: account.status,
          createdAt: account.created_at,
          updatedAt: account.updated_at,
        },
        currentPath,
        parentPath,
        folders: foldersResult.rows.map((row) => ({
          path: row.path,
          name: row.name,
        })),
        files: filesResult.rows.map((row) => ({
          fileId: row.file_id,
          name: row.name,
          sizeBytes:
            row.size === null || row.size === undefined
              ? null
              : row.size.toString(),
          sourceModifiedAt: row.source_modified_at,
          path: row.path,
          storageProvider: row.storage_provider,
          storageStatus: row.storage_status,
          isAvailable: row.is_available,
          department: row.department,
        })),
        pagination: {
          page,
          pageSize: requestedPageSize,
          total,
          totalPages,
        },
      });
    } catch (error) {
      console.error(
        "Admin Google Drive account file listing failed:",
        error
      );

      return res.status(500).json({
        error: "Failed to load Google Drive account files",
      });
    }
  }
);


// "/api/admin/drive-files"
app.get(
  "/api/admin/drive-files",
  requireAdmin,
  async (req, res) => {
    try {
      const requestedPage = Number(req.query.page ?? 1);
      const requestedPageSize = Number(req.query.pageSize ?? 50);

      if (!Number.isInteger(requestedPage) || requestedPage < 1) {
        return res.status(400).json({ error: "Page must be a positive integer" });
      }

      if (!Number.isInteger(requestedPageSize) || requestedPageSize < 1 || requestedPageSize > 100) {
        return res.status(400).json({ error: "Page size must be an integer between 1 and 100" });
      }

      const filters = normalizeDriveFileSearchFilters(req.query);
      const whereState = buildDriveFileSearchWhere(filters, 1);
      const whereSql = whereState.clauses.join("\n          AND ");

      const countResult = await pool.query(
        `
        SELECT COUNT(*)::bigint AS total
        FROM google_drive_file_accounts g
        INNER JOIN resources r
          ON r.storage_key = g.file_id
        WHERE
          ${whereSql}
        `,
        whereState.values
      );

      const total = Number(countResult.rows[0].total);
      const totalPages = Math.max(1, Math.ceil(total / requestedPageSize));
      const page = Math.min(requestedPage, totalPages);
      const offset = (page - 1) * requestedPageSize;
      const limitIndex = whereState.nextIndex;
      const offsetIndex = whereState.nextIndex + 1;
      const values = [...whereState.values, requestedPageSize, offset];

      const filesResult = await pool.query(
        `
        SELECT
          g.file_id,
          a.id AS account_id,
          a.email AS account_email,
          r.name,
          r.size,
          r.source_modified_at,
          r.path,
          r.storage_status,
          r.is_available,
          d.slug AS department
        FROM google_drive_file_accounts g
        INNER JOIN google_drive_accounts a
          ON a.id = g.account_id
        INNER JOIN resources r
          ON r.storage_key = g.file_id
        LEFT JOIN departments d
          ON d.id = r.department_id
        WHERE
          ${whereSql}
        ORDER BY
          LOWER(r.name),
          r.id,
          g.file_id
        LIMIT $${limitIndex}
        OFFSET $${offsetIndex}
        `,
        values
      );

      return res.json({
        files: filesResult.rows.map((row) => ({
          fileId: row.file_id,
          accountId: row.account_id,
          accountEmail: row.account_email,
          name: row.name,
          sizeBytes: row.size == null ? null : row.size.toString(),
          sourceModifiedAt: row.source_modified_at,
          path: row.path,
          storageStatus: row.storage_status,
          isAvailable: row.is_available,
          department: row.department,
        })),
        pagination: {
          page,
          pageSize: requestedPageSize,
          total,
          totalPages,
        },
      });
    } catch (error) {
      if (error instanceof Error && /Invalid (file type|storage status|availability) filter/.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }

      console.error("Admin Drive file search failed:", error);
      return res.status(500).json({ error: "Failed to search Google Drive files" });
    }
  }
);

// "/api/admin/accounts/:id/status"
app.patch(
  "/api/admin/accounts/:id/status",
  requireAdmin,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const { id } = req.params;
      const status = String(req.body?.status || "").trim();

      if (!["connected", "disabled"].includes(status)) {
        return res.status(400).json({
          error: "Status must be connected or disabled",
        });
      }

      await client.query("BEGIN");

      const accountResult = await client.query(
        `
        SELECT
          id,
          email,
          status
        FROM google_drive_accounts
        WHERE id = $1
        FOR UPDATE
        `,
        [id]
      );

      if (accountResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: "Google Drive account not found",
        });
      }

      if (status === "disabled") {
        const activeMigrationResult = await client.query(
          `
          SELECT
            id,
            status,
            CASE
              WHEN source_account_id = $1 THEN 'source'
              ELSE 'target'
            END AS role
          FROM google_drive_account_migrations
          WHERE status IN (
            'pending',
            'running',
            'waiting_for_storage'
          )
            AND (
              source_account_id = $1
              OR target_account_id = $1
            )
          ORDER BY created_at ASC
          LIMIT 1
          `,
          [id]
        );

        if (activeMigrationResult.rows.length > 0) {
          await client.query("ROLLBACK");

          const migration = activeMigrationResult.rows[0];

          return res.status(409).json({
            error:
              `Account cannot be disabled because it is the ${migration.role} of an active migration`,
            migrationId: migration.id,
            migrationStatus: migration.status,
            role: migration.role,
          });
        }
      }

      const result = await client.query(
        `
        UPDATE google_drive_accounts
        SET
          status = $1,
          updated_at = NOW()
        WHERE id = $2
        RETURNING
          id,
          email,
          status,
          updated_at
        `,
        [status, id]
      );

      await client.query("COMMIT");

      await logAdminActivity({
        req,
        admin: req.admin,
        eventType: status === "connected"
          ? ACTIVITY_EVENT_TYPES.DRIVE_ACCOUNT_ENABLED
          : ACTIVITY_EVENT_TYPES.DRIVE_ACCOUNT_DISABLED,
        entityType: "drive_account",
        entityId: result.rows[0].id,
        description: `${status === "connected" ? "Enabled" : "Disabled"} Google Drive account ${result.rows[0].email}`,
        metadata: {
          accountEmail: result.rows[0].email,
          previousStatus: accountResult.rows[0].status,
          nextStatus: result.rows[0].status,
        },
      });

      res.json({
        account: {
          id: result.rows[0].id,
          email: result.rows[0].email,
          status: result.rows[0].status,
          updatedAt: result.rows[0].updated_at,
        },
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "Admin Google account status update failed:",
        error
      );

      res.status(500).json({
        error: "Failed to update Google Drive account status",
      });
    } finally {
      client.release();
    }
  }
);

// "/api/admin/accounts/:id"
app.delete(
  "/api/admin/accounts/:id",
  requireAdmin,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const { id } = req.params;

      await client.query("BEGIN");

      const accountResult = await client.query(
        `
        SELECT
          id,
          email
        FROM google_drive_accounts
        WHERE id = $1
        FOR UPDATE
        `,
        [id]
      );

      if (accountResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: "Google Drive account not found",
        });
      }

      const account = accountResult.rows[0];

      const activeMigrationResult = await client.query(
        `
        SELECT
          id,
          status,
          CASE
            WHEN source_account_id = $1 THEN 'source'
            ELSE 'target'
          END AS role
        FROM google_drive_account_migrations
        WHERE status IN (
          'pending',
          'running',
          'waiting_for_storage'
        )
          AND (
            source_account_id = $1
            OR target_account_id = $1
          )
        ORDER BY created_at ASC
        LIMIT 1
        `,
        [id]
      );

      if (activeMigrationResult.rows.length > 0) {
        await client.query("ROLLBACK");

        const migration = activeMigrationResult.rows[0];

        return res.status(409).json({
          error:
            `Account cannot be removed because it is the ${migration.role} of an active migration`,
          migrationId: migration.id,
          migrationStatus: migration.status,
          role: migration.role,
        });
      }

      const mappingResult = await client.query(
        `
        SELECT COUNT(*)::bigint AS file_count
        FROM google_drive_file_accounts
        WHERE account_id = $1
        `,
        [id]
      );

      const fileCount = Number(
        mappingResult.rows[0].file_count
      );

      if (fileCount > 0) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          error:
            "Account cannot be removed because it still has mapped files",
          fileCount,
        });
      }

      const cleanupResult = await client.query(
        `
          SELECT COUNT(*) AS count
          FROM google_drive_account_migration_items i
          JOIN google_drive_account_migrations m
            ON m.id = i.migration_id
          WHERE m.source_account_id = $1
            AND i.source_delete_status <> 'deleted'
          `,
        [id]
      );

      const cleanupFailures =
        Number(cleanupResult.rows[0].count);

      if (cleanupFailures > 0) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          error:
            `Account cannot be removed because ${cleanupFailures} migrated file(s) still require source cleanup.`,
          cleanupFailures,
        });
      }

      await client.query(
        `
        DELETE FROM google_drive_accounts
        WHERE id = $1
        `,
        [id]
      );

      await client.query("COMMIT");

      await logAdminActivity({
        req,
        admin: req.admin,
        eventType: ACTIVITY_EVENT_TYPES.DRIVE_ACCOUNT_REMOVED,
        entityType: "drive_account",
        entityId: account.id,
        description: `Removed Google Drive account ${account.email}`,
        metadata: { accountEmail: account.email },
      });

      res.json({
        removed: true,
        account: {
          id: account.id,
          email: account.email,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");

      console.error(
        "Admin Google account removal failed:",
        error
      );

      res.status(500).json({
        error: "Failed to remove Google Drive account",
      });
    } finally {
      client.release();
    }
  }
);

// "/api/admin/accounts/:id/migration"
app.post(
  "/api/admin/accounts/:id/migration",
  requireAdmin,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const sourceAccountId =
        req.params.id;

      const targetAccountId = String(
        req.body?.targetAccountId || ""
      ).trim();

      const requestedLimit =
        req.body?.limit;

      const selectionMode =
        String(req.body?.selectionMode || "")
          .trim()
          .toLowerCase() ||
        (requestedLimit !== undefined &&
        requestedLimit !== null &&
        requestedLimit !== ""
          ? "count"
          : "all");

      if (
        !["all", "count", "size"].includes(
          selectionMode
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid migration selection mode",
        });
      }

      let migrationLimit = null;
      let sizeSelection = null;

      if (
        selectionMode === "count" ||
        selectionMode === "all"
      ) {
        if (
          requestedLimit !== undefined &&
          requestedLimit !== null &&
          requestedLimit !== ""
        ) {
          const parsedLimit =
            Number(requestedLimit);

          if (
            !Number.isInteger(parsedLimit) ||
            parsedLimit < 1 ||
            parsedLimit > 100000
          ) {
            return res.status(400).json({
              error:
                "Migration limit must be an integer between 1 and 100000",
            });
          }

          migrationLimit = parsedLimit;
        }
      }

      if (selectionMode === "size") {
        const parseBigIntField = (
          value,
          fieldName
        ) => {
          try {
            if (
              value === undefined ||
              value === null ||
              value === ""
            ) {
              throw new Error(
                `${fieldName} is required`
              );
            }

            return BigInt(String(value));
          } catch {
            throw new Error(
              `${fieldName} must be a valid integer`
            );
          }
        };

        let targetSizeBytes;
        let minimumFileSizeBytes;
        let maximumFileSizeBytes;
        let maxFileCount;

        try {
          targetSizeBytes =
            parseBigIntField(
              req.body?.targetSizeBytes,
              "targetSizeBytes"
            );

          minimumFileSizeBytes =
            parseBigIntField(
              req.body?.minimumFileSizeBytes,
              "minimumFileSizeBytes"
            );

          maximumFileSizeBytes =
            parseBigIntField(
              req.body?.maximumFileSizeBytes,
              "maximumFileSizeBytes"
            );

          maxFileCount =
            Number(req.body?.maxFileCount);
        } catch (error) {
          return res.status(400).json({
            error:
              error instanceof Error
                ? error.message
                : "Invalid size-based migration selection",
          });
        }

        if (targetSizeBytes <= 0n) {
          return res.status(400).json({
            error:
              "Target migration size must be greater than 0 bytes",
          });
        }

        if (minimumFileSizeBytes < 0n) {
          return res.status(400).json({
            error:
              "Minimum file size cannot be negative",
          });
        }

        if (maximumFileSizeBytes <= 0n) {
          return res.status(400).json({
            error:
              "Maximum file size must be greater than 0 bytes",
          });
        }

        if (
          maximumFileSizeBytes <
          minimumFileSizeBytes
        ) {
          return res.status(400).json({
            error:
              "Maximum file size must be at least the minimum file size",
          });
        }

        if (
          !Number.isInteger(maxFileCount) ||
          maxFileCount < 1 ||
          maxFileCount > 100000
        ) {
          return res.status(400).json({
            error:
              "Maximum file count must be an integer between 1 and 100000",
          });
        }

        sizeSelection = {
          targetSizeBytes,
          minimumFileSizeBytes,
          maximumFileSizeBytes,
          maxFileCount,
        };
      }

      if (!targetAccountId) {
        return res.status(400).json({
          error: "Target account is required",
        });
      }

      if (
        sourceAccountId ===
        targetAccountId
      ) {
        return res.status(400).json({
          error:
            "Source and target accounts must be different",
        });
      }

      await client.query("BEGIN");

      const accountsResult =
        await client.query(
          `
          SELECT
            id,
            email,
            status
          FROM google_drive_accounts
          WHERE id IN ($1, $2)
          FOR UPDATE
          `,
          [
            sourceAccountId,
            targetAccountId,
          ]
        );

      if (
        accountsResult.rows.length !== 2
      ) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error:
            "Source or target Google Drive account not found",
        });
      }

      const source =
        accountsResult.rows.find(
          (account) =>
            account.id ===
            sourceAccountId
        );

      const target =
        accountsResult.rows.find(
          (account) =>
            account.id ===
            targetAccountId
        );

      if (!source || !target) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error:
            "Source or target Google Drive account not found",
        });
      }

      if (
        source.status !== "connected"
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          error:
            "Source account must be connected",
        });
      }

      if (
        target.status !== "connected"
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          error:
            "Target account must be connected",
        });
      }

      const activeMigrationResult =
        await client.query(
          `
          SELECT
            id,
            status
          FROM google_drive_account_migrations
          WHERE source_account_id = $1
            AND status IN (
              'pending',
              'running',
              'waiting_for_storage'
            )
          LIMIT 1
          `,
          [sourceAccountId]
        );

      if (
        activeMigrationResult.rows.length >
        0
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          error:
            "A migration is already active for this account",
          migrationId:
            activeMigrationResult
              .rows[0].id,
          status:
            activeMigrationResult
              .rows[0].status,
        });
      }

      /*
       * Only select actual, available files.
       * This guarantees every migration item
       * has a corresponding resources row.
       */
      const countResult =
        await client.query(
          `
          SELECT
            COUNT(*)::bigint AS file_count
          FROM google_drive_file_accounts f
          JOIN resources r
            ON r.storage_key = f.file_id
          WHERE f.account_id = $1
            AND r.type = 'file'
            AND r.is_available = TRUE
          `,
          [sourceAccountId]
        );

      const availableFiles =
        Number(
          countResult.rows[0]
            .file_count
        );

      if (availableFiles === 0) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          error:
            "Account has no available mapped files to migrate",
        });
      }

      let totalFiles;
      let selectedFileIds = null;
      let selectedBytes = null;

      if (sizeSelection) {
        /*
         * Size-based benchmark selection:
         *
         * 1. Only actual available files.
         * 2. Ignore unknown/small files below the threshold.
         * 3. Consider largest files first.
         * 4. Stop once the requested size is reached.
         * 5. Never select more than maxFileCount.
         *
         * We intentionally do the accumulation in Node using
         * BigInt so large byte totals remain exact.
         */
        const candidatesResult =
          await client.query(
            `
            SELECT
              f.file_id,
              COALESCE(r.size, 0)::bigint AS size_bytes
            FROM google_drive_file_accounts f
            JOIN resources r
              ON r.storage_key = f.file_id
            WHERE f.account_id = $1
              AND r.type = 'file'
              AND r.is_available = TRUE
              AND COALESCE(r.size, 0)::bigint >= $2
              AND COALESCE(r.size, 0)::bigint <= $3
            ORDER BY
              COALESCE(r.size, 0)::bigint DESC,
              f.file_id
            LIMIT $4
            `,
            [
              sourceAccountId,
              sizeSelection.minimumFileSizeBytes.toString(),
              sizeSelection.maximumFileSizeBytes.toString(),
              sizeSelection.maxFileCount,
            ]
          );

        selectedFileIds = [];
        selectedBytes = 0n;

        for (
          const row of candidatesResult.rows
        ) {
          selectedFileIds.push(row.file_id);

          selectedBytes += BigInt(
            row.size_bytes || 0
          );

          if (
            selectedBytes >=
            sizeSelection.targetSizeBytes
          ) {
            break;
          }
        }

        if (selectedFileIds.length === 0) {
          await client.query("ROLLBACK");

          return res.status(409).json({
            error:
              "No available files match the requested minimum file size",
          });
        }

        totalFiles =
          selectedFileIds.length;

        /*
         * file_limit is intentionally non-null for a
         * size-limited migration so the source account
         * cannot be removed before this limited migration
         * is fully completed.
         */
        migrationLimit = totalFiles;

        /*
         * The target may not be reachable within the
         * maximum file count. That is allowed; the UI
         * requested a maximum, not an exact byte count.
         */
      } else {
        totalFiles =
          migrationLimit === null
            ? availableFiles
            : Math.min(
              migrationLimit,
              availableFiles
            );
      }

      const migrationId =
        crypto.randomUUID();

      /*
       * Create migration.
       */
      const insertMigrationResult =
        await client.query(
          `
          INSERT INTO google_drive_account_migrations (
            id,
            source_account_id,
            target_account_id,
            status,
            file_limit,
            total_files
          )
          VALUES (
            $1,
            $2,
            $3,
            'pending',
            $4,
            $5
          )
          RETURNING
            id,
            source_account_id,
            target_account_id,
            status,
            file_limit,
            total_files,
            completed_files,
            failed_files,
            current_file_id,
            created_at
          `,
          [
            migrationId,
            sourceAccountId,
            targetAccountId,
            migrationLimit,
            totalFiles,
          ]
        );

      /*
       * Populate the actual migration items
       * in the SAME transaction.
       */
      let insertItemsResult;

      if (selectedFileIds) {
        /*
         * Re-select exactly the files chosen above.
         * Dynamic placeholders keep this independent of
         * the underlying file_id PostgreSQL type.
         */
        const filePlaceholders =
          selectedFileIds
            .map(
              (_, index) =>
                `$${index + 3}`
            )
            .join(", ");

        insertItemsResult =
          await client.query(
            `
            INSERT INTO google_drive_account_migration_items (
              id,
              migration_id,
              source_file_id,
              status,
              size_bytes
            )
            SELECT
              gen_random_uuid()::text,
              $1,
              f.file_id,
              'pending',
              COALESCE(r.size, 0)
            FROM google_drive_file_accounts f
            JOIN resources r
              ON r.storage_key = f.file_id
            WHERE f.account_id = $2
              AND r.type = 'file'
              AND r.is_available = TRUE
              AND f.file_id IN (${filePlaceholders})
            `,
            [
              migrationId,
              sourceAccountId,
              ...selectedFileIds,
            ]
          );
      } else {
        insertItemsResult =
          await client.query(
            `
            INSERT INTO google_drive_account_migration_items (
              id,
              migration_id,
              source_file_id,
              status,
              size_bytes
            )
            SELECT
              gen_random_uuid()::text,
              $1,
              f.file_id,
              'pending',
              COALESCE(r.size, 0)
            FROM google_drive_file_accounts f
            JOIN resources r
              ON r.storage_key = f.file_id
            WHERE f.account_id = $2
              AND r.type = 'file'
              AND r.is_available = TRUE
            ORDER BY f.file_id
            LIMIT $3
            `,
            [
              migrationId,
              sourceAccountId,
              totalFiles,
            ]
          );
      }

      if (
        insertItemsResult.rowCount !==
        totalFiles
      ) {
        throw new Error(
          `Expected ${totalFiles} migration items but created ${insertItemsResult.rowCount}`
        );
      }

      await client.query("COMMIT");

      await logAdminActivity({
        req,
        admin: req.admin,
        eventType: ACTIVITY_EVENT_TYPES.MIGRATION_CREATED,
        entityType: "migration",
        entityId: migrationId,
        description: `Started migration from ${source.email} to ${target.email}`,
        metadata: {
          sourceAccountId,
          sourceEmail: source.email,
          targetAccountId,
          targetEmail: target.email,
          totalFiles,
          fileLimit: migrationLimit,
          selectionMode,
          targetSizeBytes:
            sizeSelection
              ? sizeSelection.targetSizeBytes.toString()
              : null,
          minimumFileSizeBytes:
            sizeSelection
              ? sizeSelection.minimumFileSizeBytes.toString()
              : null,
          maximumFileSizeBytes:
            sizeSelection
              ? sizeSelection.maximumFileSizeBytes.toString()
              : null,
          selectedBytes:
            selectedBytes === null
              ? null
              : selectedBytes.toString(),
        },
      });

      const migration =
        insertMigrationResult
          .rows[0];

      return res.status(201).json({
        migration: {
          id: migration.id,

          sourceAccountId:
            migration
              .source_account_id,

          targetAccountId:
            migration
              .target_account_id,

          sourceEmail:
            source.email,

          targetEmail:
            target.email,

          status:
            migration.status,

          fileLimit:
            migration.file_limit ===
              null
              ? null
              : Number(
                migration.file_limit
              ),

          totalFiles: Number(
            migration.total_files
          ),

          completedFiles: Number(
            migration.completed_files
          ),

          failedFiles: Number(
            migration.failed_files
          ),

          currentFileId:
            migration.current_file_id,

          createdAt:
            migration.created_at,

          transferredFiles: 0,

          sourceDeletedFiles: 0,

          cleanupFailedFiles: 0,

          pendingFiles:
            Number(
              migration.total_files
            ),

          runningFiles: 0,

          progress: 0,
        },
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch { }

      if (
        error?.code === "23505"
      ) {
        return res.status(409).json({
          error:
            "A migration is already active for this account",
        });
      }

      console.error(
        "Admin migration creation failed:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to create account migration",
      });
    } finally {
      client.release();
    }
  }
);

// "/api/admin/migrations/:id"
app.get(
  "/api/admin/migrations/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          m.id,
          m.source_account_id,
          m.target_account_id,
          m.status,
          m.cancel_requested,
          m.file_limit,
          m.total_files,
          m.completed_files,
          m.failed_files,
          m.current_file_id,
          m.error_message,
          m.started_at,
          m.finished_at,
          m.created_at,
          m.updated_at,
          s.email AS source_email,
          t.email AS target_email,

          COUNT(i.id) FILTER (
            WHERE i.status = 'pending'
          ) AS pending_files,

          COUNT(i.id) FILTER (
            WHERE i.status = 'running'
          ) AS running_files,

          COUNT(i.id) FILTER (
            WHERE i.status = 'completed'
          ) AS completed_items,

          COUNT(i.id) FILTER (
            WHERE i.status = 'failed'
          ) AS failed_items,

          COUNT(i.id) FILTER (
            WHERE i.source_delete_status = 'deleted'
          ) AS source_deleted_files,

          COUNT(i.id) FILTER (
            WHERE i.source_delete_status = 'failed'
          ) AS source_delete_failed_files,

          COALESCE(
            SUM(i.size_bytes),
            0
          ) AS total_bytes,

          COALESCE(
            SUM(i.bytes_transferred),
            0
          ) AS transferred_bytes,

          MAX(
            CASE
              WHEN i.source_file_id = m.current_file_id
              THEN i.id
            END
          ) AS current_item_id,

          MAX(
            CASE
              WHEN i.source_file_id = m.current_file_id
              THEN i.size_bytes
            END
          ) AS current_file_size,

          MAX(
            CASE
              WHEN i.source_file_id = m.current_file_id
              THEN i.bytes_transferred
            END
          ) AS current_file_bytes,

          MAX(
            CASE
              WHEN i.source_file_id = m.current_file_id
              THEN i.speed_bytes_per_second
            END
          ) AS current_file_speed_bytes_per_second,

          COALESCE(
            SUM(i.speed_bytes_per_second) FILTER (WHERE i.status = 'running'),
            0
          ) AS active_speed_bytes_per_second,

          MAX(
            CASE
              WHEN i.source_file_id = m.current_file_id
              THEN i.transfer_phase
            END
          ) AS current_file_phase,

          MAX(
            CASE
              WHEN i.source_file_id = m.current_file_id
              THEN i.started_at
            END
          ) AS current_file_started_at,

          MAX(
            CASE
              WHEN i.source_file_id = m.current_file_id
              THEN r.name
            END
          ) AS current_file_name,

          MAX(
            CASE
              WHEN i.source_file_id = m.current_file_id
              THEN i.target_account_id
            END
          ) AS current_target_account_id

        FROM google_drive_account_migrations m

        JOIN google_drive_accounts s
          ON s.id = m.source_account_id

        JOIN google_drive_accounts t
          ON t.id = m.target_account_id

        LEFT JOIN google_drive_account_migration_items i
          ON i.migration_id = m.id

        LEFT JOIN resources r
          ON r.storage_key = i.source_file_id

        WHERE m.id = $1

        GROUP BY
          m.id,
          m.source_account_id,
          m.target_account_id,
          m.status,
          m.cancel_requested,
          m.file_limit,
          m.total_files,
          m.completed_files,
          m.failed_files,
          m.current_file_id,
          m.error_message,
          m.started_at,
          m.finished_at,
          m.created_at,
          m.updated_at,
          s.email,
          t.email

        LIMIT 1
        `,
        [req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Migration not found",
        });
      }

      const row = result.rows[0];
      const totalBytes =
        BigInt(row.total_bytes ?? 0);

      const transferredBytes =
        BigInt(row.transferred_bytes ?? 0);

      const migrationStartedAt =
        row.started_at
          ? new Date(row.started_at)
          : null;

      const migrationEndedAt =
        row.finished_at
          ? new Date(row.finished_at)
          : new Date();

      const migrationElapsedSeconds =
        migrationStartedAt
          ? Math.max(
            0,
            (migrationEndedAt.getTime() -
              migrationStartedAt.getTime()) /
            1000
          )
          : 0;

      const historicalAverageSpeedBytesPerSecond =
        migrationElapsedSeconds > 0
          ? Number(transferredBytes) /
          migrationElapsedSeconds
          : 0;

      const activeSpeedBytesPerSecond = Number(
        row.active_speed_bytes_per_second ?? 0
      );

      const overallSpeedBytesPerSecond =
        row.status === "running" && activeSpeedBytesPerSecond > 0
          ? activeSpeedBytesPerSecond
          : historicalAverageSpeedBytesPerSecond;

      const remainingBytes =
        totalBytes > transferredBytes
          ? totalBytes - transferredBytes
          : 0n;

      const totalEtaSeconds =
        row.status === "completed"
          ? 0
          : (
              row.status === "running" ||
              row.status === "pending"
            ) &&
            overallSpeedBytesPerSecond > 0
            ? Number(remainingBytes) /
              overallSpeedBytesPerSecond
            : null;

      const currentFileBytes =
        BigInt(row.current_file_bytes ?? 0);

      const currentFileSize =
        BigInt(row.current_file_size ?? 0);

      const currentFileStartedAt =
        row.current_file_started_at
          ? new Date(row.current_file_started_at)
          : null;

      const currentFileElapsedSeconds =
        currentFileStartedAt
          ? Math.max(
            0,
            (Date.now() -
              currentFileStartedAt.getTime()) /
            1000
          )
          : 0;

      const currentFileSpeedBytesPerSecond =
        Number(row.current_file_speed_bytes_per_second ?? 0) > 0
          ? Number(row.current_file_speed_bytes_per_second)
          : currentFileElapsedSeconds > 0
            ? Number(currentFileBytes) / currentFileElapsedSeconds
            : 0;

      const currentFileRemainingBytes =
        currentFileSize > currentFileBytes
          ? currentFileSize -
          currentFileBytes
          : 0n;

      const currentFileEtaSeconds =
        currentFileSpeedBytesPerSecond > 0
          ? Number(
            currentFileRemainingBytes
          ) /
          currentFileSpeedBytesPerSecond
          : null;

      const totalFiles = Number(
        row.total_files
      );

      const transferredFiles = Number(
        row.completed_files
      );

      const sourceDeletedFiles = Number(
        row.source_deleted_files
      );

      const cleanupFailedFiles = Number(
        row.source_delete_failed_files
      );

      const pendingFiles = Number(
        row.pending_files
      );

      const runningFiles = Number(
        row.running_files
      );

      const failedFiles = Number(
        row.failed_items
      );

      const progress =
        totalBytes > 0n
          ? Math.min(
              100,
              Math.floor(
                (Number(transferredBytes) /
                  Number(totalBytes)) *
                  100
              )
            )
          : totalFiles > 0
            ? Math.floor(
                (transferredFiles /
                  totalFiles) *
                  100
              )
            : 0;

      return res.json({
        migration: {
          id: row.id,

          status: row.status,

          cancelRequested:
            Boolean(row.cancel_requested),

          sourceAccountId:
            row.source_account_id,

          targetAccountId:
            row.target_account_id,

          sourceEmail:
            row.source_email,

          targetEmail:
            row.target_email,

          totalFiles,

          fileLimit:
            row.file_limit === null
              ? null
              : Number(row.file_limit),

          transferredFiles,

          sourceDeletedFiles,

          cleanupFailedFiles,

          pendingFiles,

          runningFiles,

          failedFiles,

          completedItems:
            Number(row.completed_items),

          progress,

          currentFileId:
            row.current_file_id,

          errorMessage:
            row.error_message,

          startedAt:
            row.started_at,

          finishedAt:
            row.finished_at,

          createdAt:
            row.created_at,

          updatedAt:
            row.updated_at,

          live: {
            totalBytes:
              totalBytes.toString(),

            transferredBytes:
              transferredBytes.toString(),

            overallSpeedBytesPerSecond:
              overallSpeedBytesPerSecond,

            activeSpeedBytesPerSecond:
              activeSpeedBytesPerSecond,

            totalEtaSeconds:
              totalEtaSeconds,

            migrationElapsedSeconds:
              migrationElapsedSeconds,

            currentFile: {
              id: row.current_item_id,
              name: row.current_file_name,
              phase: row.current_file_phase,

              sizeBytes:
                currentFileSize.toString(),

              bytesTransferred:
                currentFileBytes.toString(),

              speedBytesPerSecond:
                currentFileSpeedBytesPerSecond,

              etaSeconds:
                currentFileEtaSeconds,

              elapsedSeconds:
                currentFileElapsedSeconds,

              targetAccountId:
                row.current_target_account_id,
            },
          },
        },
      });
    } catch (error) {
      console.error(
        "Admin migration status lookup failed:",
        error
      );

      return res.status(500).json({
        error: "Failed to load migration",
      });
    }
  }
);

// "/api/admin/migrations/:id/cancel"
app.post(
  "/api/admin/migrations/:id/cancel",
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        UPDATE google_drive_account_migrations m
        SET
          cancel_requested = TRUE,
          status = CASE
            WHEN m.status IN ('pending', 'waiting_for_storage')
              AND NOT EXISTS (
                SELECT 1
                FROM google_drive_account_migration_items i
                WHERE i.migration_id = m.id
                  AND i.status = 'running'
              )
            THEN 'cancelled'
            ELSE m.status
          END,
          finished_at = CASE
            WHEN m.status IN ('pending', 'waiting_for_storage')
              AND NOT EXISTS (
                SELECT 1
                FROM google_drive_account_migration_items i
                WHERE i.migration_id = m.id
                  AND i.status = 'running'
              )
            THEN NOW()
            ELSE m.finished_at
          END,
          updated_at = NOW()
        WHERE m.id = $1
          AND m.status IN (
            'pending',
            'running',
            'waiting_for_storage'
          )
        RETURNING
          m.id,
          m.status,
          m.cancel_requested,
          m.total_files,
          m.completed_files,
          m.failed_files
        `,
        [req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(409).json({
          error:
            "Migration does not exist or is no longer cancellable",
        });
      }

      const migration = result.rows[0];

      await logAdminActivity({
        req,
        admin: req.admin,
        eventType: ACTIVITY_EVENT_TYPES.MIGRATION_CANCEL_REQUESTED,
        entityType: "migration",
        entityId: migration.id,
        description: `Requested cancellation for migration ${migration.id}`,
        metadata: {
          status: migration.status,
          totalFiles: Number(migration.total_files),
          completedFiles: Number(migration.completed_files),
          failedFiles: Number(migration.failed_files),
        },
      });

      return res.json({
        migration: {
          id: migration.id,
          status: migration.status,
          totalFiles: Number(
            migration.total_files
          ),
          completedFiles: Number(
            migration.completed_files
          ),
          failedFiles: Number(
            migration.failed_files
          ),
          cancelRequested:
            Boolean(migration.cancel_requested),
        },
      });
    } catch (error) {
      console.error(
        "Admin migration cancellation failed:",
        error
      );

      return res.status(500).json({
        error: "Failed to cancel migration",
      });
    }
  }
);

// "/api/admin/auth/google"
app.get(
  "/api/admin/auth/google",
  (req, res) => {
    try {
      const url =
        getGoogleAuthorizationUrl();

      res.redirect(url);
    } catch (error) {
      console.error(
        "Admin Google login start failed:",
        error
      );

      res.status(500).json({
        error: "Failed to start admin login",
      });
    }
  }
);

// "/api/admin/auth/google/callback"
app.get(
  "/api/admin/auth/google/callback",
  async (req, res) => {
    try {
      const { code, state } = req.query;

      const result =
        await handleGoogleCallback(
          String(code || ""),
          String(state || "")
        );

      setSessionCookie(
        res,
        result.sessionId
      );

      await logAdminActivity({
        req,
        admin: { id: null, email: result.email },
        eventType: ACTIVITY_EVENT_TYPES.ADMIN_LOGIN,
        entityType: "admin_session",
        entityId: result.sessionId,
        description: `Admin login for ${result.email}`,
      });

      const frontendUrl =
        process.env.FRONTEND_URL || "http://localhost:5173";

      res.redirect(`${frontendUrl}/admin`);
    } catch (error) {
      console.error(
        "Admin Google callback failed:",
        error
      );

      res.status(403).send(`
        <!doctype html>
        <html>
          <body>
            <h1>Admin login failed</h1>
            <p>${String(
        error.message ||
        "Authorization failed"
      )}</p>
            <a href="/admin/login">
              Back to admin login
            </a>
          </body>
        </html>
      `);
    }
  }
);

// "/api/admin/auth/me"
app.get(
  "/api/admin/auth/me",
  async (req, res) => {
    try {
      const sessionId =
        parseSessionCookie(req);

      const admin =
        await getAdminFromSession(
          sessionId
        );

      if (!admin) {
        return res.status(401).json({
          authenticated: false,
        });
      }

      return res.json({
        authenticated: true,
        email: admin.email,
        role: admin.role,
      });
    } catch (error) {
      console.error(
        "Admin session lookup failed:",
        error
      );

      return res.status(500).json({
        error: "Failed to check admin session",
      });
    }
  }
);

// "/api/admin/auth/logout"
app.post(
  "/api/admin/auth/logout",
  async (req, res) => {
    try {
      const sessionId =
        parseSessionCookie(req);
      const admin = await getAdminFromSession(sessionId);

      await deleteAdminSession(
        sessionId
      );

      if (admin) {
        await logAdminActivity({
          req,
          admin,
          eventType: ACTIVITY_EVENT_TYPES.ADMIN_LOGOUT,
          entityType: "admin_session",
          entityId: sessionId,
          description: `Admin logout for ${admin.email}`,
        });
      }

      clearSessionCookie(res);

      res.json({
        authenticated: false,
      });
    } catch (error) {
      console.error(
        "Admin logout failed:",
        error
      );

      res.status(500).json({
        error: "Failed to log out",
      });
    }
  }
);

// "/api/admin/admins"
app.get(
  "/api/admin/admins",
  requireOwner,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          id,
          email,
          role,
          status,
          created_at,
          updated_at
        FROM admin_users
        ORDER BY
          CASE WHEN role = 'owner' THEN 0 ELSE 1 END,
          created_at ASC,
          id ASC
      `);

      res.json({
        admins: result.rows.map((row) => ({
          id: row.id,
          email: row.email,
          role: row.role,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      });
    } catch (error) {
      console.error("Admin user listing failed:", error);
      res.status(500).json({
        error: "Failed to load admin accounts",
      });
    }
  }
);

// "/api/admin/admins"
app.post(
  "/api/admin/admins",
  requireOwner,
  async (req, res) => {
    try {
      const email = String(req.body?.email || "")
        .trim()
        .toLowerCase();
      const role = String(req.body?.role || "admin")
        .trim()
        .toLowerCase();

      if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        return res.status(400).json({
          error: "A valid Google email address is required",
        });
      }

      if (!['admin', 'owner'].includes(role)) {
        return res.status(400).json({
          error: "Role must be admin or owner",
        });
      }

      const result = await pool.query(`
        INSERT INTO admin_users (email, role, status, updated_at)
        VALUES ($1, $2, 'active', NOW())
        ON CONFLICT (email)
        DO UPDATE SET
          role = EXCLUDED.role,
          status = 'active',
          updated_at = NOW()
        RETURNING id, email, role, status, created_at, updated_at
      `, [email, role]);

      await logAdminActivity({
        req,
        admin: req.admin,
        eventType: ACTIVITY_EVENT_TYPES.ADMIN_CREATED,
        entityType: "admin_user",
        entityId: result.rows[0].id,
        description: `Added admin access for ${result.rows[0].email}`,
        metadata: { role: result.rows[0].role },
      });

      res.status(201).json({
        admin: {
          id: result.rows[0].id,
          email: result.rows[0].email,
          role: result.rows[0].role,
          status: result.rows[0].status,
          createdAt: result.rows[0].created_at,
          updatedAt: result.rows[0].updated_at,
        },
      });
    } catch (error) {
      if (error?.code === '23505') {
        return res.status(409).json({
          error: "An admin with that email already exists",
        });
      }
      console.error("Admin user creation failed:", error);
      res.status(500).json({
        error: "Failed to create admin account",
      });
    }
  }
);

// "/api/admin/admins/:id"
app.patch(
  "/api/admin/admins/:id",
  requireOwner,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const id = String(req.params.id || "").trim();
      const requestedRole = req.body?.role;
      const requestedStatus = req.body?.status;

      if (
        requestedRole !== undefined &&
        !['admin', 'owner'].includes(String(requestedRole).trim().toLowerCase())
      ) {
        return res.status(400).json({
          error: "Role must be admin or owner",
        });
      }

      if (
        requestedStatus !== undefined &&
        !['active', 'disabled'].includes(String(requestedStatus).trim().toLowerCase())
      ) {
        return res.status(400).json({
          error: "Status must be active or disabled",
        });
      }

      await client.query('BEGIN');

      const currentResult = await client.query(`
        SELECT id, email, role, status
        FROM admin_users
        WHERE id = $1
        FOR UPDATE
      `, [id]);

      if (currentResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Admin account not found' });
      }

      const current = currentResult.rows[0];
      const nextRole = requestedRole === undefined
        ? current.role
        : String(requestedRole).trim().toLowerCase();
      const nextStatus = requestedStatus === undefined
        ? current.status
        : String(requestedStatus).trim().toLowerCase();

      if (current.role === 'owner' && (nextRole !== 'owner' || nextStatus !== 'active')) {
        const ownerCountResult = await client.query(`
          SELECT COUNT(*)::int AS count
          FROM admin_users
          WHERE role = 'owner'
            AND status = 'active'
        `);

        if (Number(ownerCountResult.rows[0].count) <= 1) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'The last active owner cannot be disabled or demoted',
          });
        }
      }

      const result = await client.query(`
        UPDATE admin_users
        SET
          role = $1,
          status = $2,
          updated_at = NOW()
        WHERE id = $3
        RETURNING id, email, role, status, created_at, updated_at
      `, [nextRole, nextStatus, id]);

      if (nextStatus === 'disabled') {
        await client.query(`
          DELETE FROM admin_sessions
          WHERE admin_user_id = $1
        `, [id]);
      }

      await client.query('COMMIT');

      await logAdminActivity({
        req,
        admin: req.admin,
        eventType: ACTIVITY_EVENT_TYPES.ADMIN_UPDATED,
        entityType: "admin_user",
        entityId: result.rows[0].id,
        description: `Updated admin access for ${result.rows[0].email}`,
        metadata: {
          previousRole: current.role,
          previousStatus: current.status,
          role: result.rows[0].role,
          status: result.rows[0].status,
        },
      });

      res.json({
        admin: {
          id: result.rows[0].id,
          email: result.rows[0].email,
          role: result.rows[0].role,
          status: result.rows[0].status,
          createdAt: result.rows[0].created_at,
          updatedAt: result.rows[0].updated_at,
        },
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      console.error("Admin user update failed:", error);
      res.status(500).json({ error: "Failed to update admin account" });
    } finally {
      client.release();
    }
  }
);

// "/api/admin/admins/:id"
app.delete(
  "/api/admin/admins/:id",
  requireOwner,
  async (req, res) => {
    const client = await pool.connect();

    try {
      const id = String(req.params.id || '').trim();

      if (String(req.admin.id) === id) {
        return res.status(409).json({
          error: 'You cannot remove your own admin account',
        });
      }

      await client.query('BEGIN');

      const currentResult = await client.query(`
        SELECT id, email, role, status
        FROM admin_users
        WHERE id = $1
        FOR UPDATE
      `, [id]);

      if (currentResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Admin account not found' });
      }

      const current = currentResult.rows[0];

      if (current.role === 'owner') {
        const ownerCountResult = await client.query(`
          SELECT COUNT(*)::int AS count
          FROM admin_users
          WHERE role = 'owner'
            AND status = 'active'
        `);

        if (Number(ownerCountResult.rows[0].count) <= 1) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'The last active owner cannot be removed',
          });
        }
      }

      await client.query(`
        DELETE FROM admin_users
        WHERE id = $1
      `, [id]);

      await client.query('COMMIT');

      await logAdminActivity({
        req,
        admin: req.admin,
        eventType: ACTIVITY_EVENT_TYPES.ADMIN_REMOVED,
        entityType: "admin_user",
        entityId: current.id,
        description: `Removed admin access for ${current.email}`,
        metadata: { role: current.role, status: current.status },
      });

      res.json({
        removed: true,
        admin: {
          id: current.id,
          email: current.email,
        },
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      console.error("Admin user removal failed:", error);
      res.status(500).json({ error: "Failed to remove admin account" });
    } finally {
      client.release();
    }
  }
);

// "/api/admin/accounts/google/start"
app.get(
  "/api/admin/accounts/google/start",
  requireAdmin,
  (req, res) => {
    try {
      const sessionId = parseSessionCookie(req);

      if (!sessionId) {
        return res.status(401).json({
          error: "Admin authentication required",
        });
      }

      const url =
        getDriveAccountAuthorizationUrl(
          sessionId
        );

      res.redirect(url);
    } catch (error) {
      console.error(
        "Drive account OAuth start failed:",
        error
      );

      res.status(500).json({
        error:
          "Failed to start Google Drive account connection",
      });
    }
  }
);

// "/api/admin/accounts/google/callback"
app.get(
  "/api/admin/accounts/google/callback",
  requireAdmin,
  async (req, res) => {
    try {
      const { code, state } = req.query;

      const sessionId = parseSessionCookie(req);

      if (!sessionId) {
        throw new Error(
          "Admin authentication required"
        );
      }

      const connection = await handleDriveAccountCallback(
        String(code || ""),
        String(state || ""),
        sessionId
      );

      await logAdminActivity({
        req,
        admin: req.admin,
        eventType: ACTIVITY_EVENT_TYPES.DRIVE_ACCOUNT_CONNECTED,
        entityType: "drive_account",
        entityId: connection.accountId,
        description: `${connection.replaced ? "Reconnected" : "Connected"} Google Drive account ${connection.email}`,
        metadata: { replaced: connection.replaced, accountEmail: connection.email },
      });

      const frontendUrl =
        process.env.FRONTEND_URL ||
        "http://localhost:5173";

      res.redirect(
        `${frontendUrl}/admin/accounts?connected=1`
      );
    } catch (error) {
      console.error(
        "Drive account OAuth callback failed:",
        error
      );

      const frontendUrl =
        process.env.FRONTEND_URL ||
        "http://localhost:5173";

      res.redirect(
        `${frontendUrl}/admin/accounts?error=${encodeURIComponent(
          error.message ||
          "Google account connection failed"
        )}`
      );
    }
  }
);

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});
app.get("/api/browse", async (req, res) => {
  try {
    const rawPath = String(req.query.path || "").trim();

    const path = rawPath
      .split("/")
      .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
      .join("/");

    if (!path) {
      return res.status(400).json({
        error: "Missing path",
      });
    }

    if (!path.startsWith("/noticeboards/")) {
      return res.status(400).json({
        error: "Invalid path",
      });
    }

    /*
     * PostgreSQL is now the source for browsing.
     * The college server is not contacted here.
     */
    const result = await pool.query(
      `
      SELECT
        r.name,
        r.type,
        r.source_modified_at,
        r.size,
        r.path,
        r.url
      FROM resources r
      WHERE
        r.parent_path = $1
        AND r.is_available = TRUE
      ORDER BY
        CASE
          WHEN r.type = 'folder' THEN 0
          ELSE 1
        END,
        LOWER(r.name)
      `,
      [path]
    );

    const items = result.rows.map((row) => ({
      name: row.name,
      type: row.type,
      date: row.source_modified_at,
      size: row.size,
      path: row.path,
    }));

    res.json({
      path,
      items,
    });
  } catch (error) {
    console.error("PostgreSQL browse failed:", error);

    res.status(500).json({
      error: "Failed to browse database",
      message: error.message,
    });
  }
});

app.get("/api/file-status", async (req, res) => {
  try {
    const rawPath = String(req.query.path || "").trim();

    if (!rawPath) {
      return res.status(400).json({
        error: "Missing path",
      });
    }

    const path = rawPath
      .split("/")
      .map((segment) => {
        if (!segment) return "";
        return encodeURIComponent(decodeURIComponent(segment));
      })
      .join("/");

    if (!path.startsWith("/noticeboards/")) {
      return res.status(400).json({
        error: "Invalid path",
      });
    }

    const result = await pool.query(
      `
      SELECT
        type,
        storage_provider,
        storage_status,
        is_available
      FROM resources
      WHERE path = $1
      LIMIT 1
      `,
      [path]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "File not found",
      });
    }

    const resource = result.rows[0];

    if (resource.type !== "file") {
      return res.status(400).json({
        error: "Resource is not a file",
      });
    }

    if (!resource.is_available) {
      return res.status(410).json({
        available: false,
        reason: "resource_unavailable",
      });
    }

    if (
      resource.storage_provider === "college" &&
      resource.storage_status === "failed"
    ) {
      return res.status(410).json({
        available: false,
        reason: "source_unavailable",
      });
    }

    return res.json({
      available: true,
      storageProvider: resource.storage_provider,
      storageStatus: resource.storage_status,
    });
  } catch (error) {
    console.error("File status check failed:", error);

    return res.status(500).json({
      error: "Failed to check file status",
      message: error.message,
    });
  }
});

app.get("/api/file", async (req, res) => {
  try {
    const rawPath = String(req.query.path || "").trim();
    const download = req.query.download === "1";

    if (!rawPath) {
      return res.status(400).json({
        error: "Missing path",
      });
    }

    const path = rawPath
      .split("/")
      .map((segment) => {
        if (!segment) return "";

        return encodeURIComponent(decodeURIComponent(segment))
          .replace(/%40/gi, "@")
          .replace(/%24/gi, "$");
      })
      .join("/");

    if (!path.startsWith("/noticeboards/")) {
      return res.status(400).json({
        error: "Invalid path",
      });
    }

    /*
     * Find the resource in PostgreSQL.
     */
    const result = await pool.query(
      `
      SELECT
        r.name,
        r.type,
        r.path,
        r.url,
        r.size,
        r.storage_provider,
        r.storage_key,
        r.storage_status,
        r.is_available
      FROM resources r
      WHERE r.path = $1
      LIMIT 1
      `,
      [path]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "File not found",
        path,
      });
    }

    const resource = result.rows[0];

    if (!resource.is_available) {
      return res.status(410).json({
        error: "File is no longer available",
        path,
      });
    }
    if (
      resource.storage_provider === "college" &&
      resource.storage_status === "failed"
    ) {
      return res.status(410).json({
        error: "File is no longer available on the college server",
        path,
      });
    }

    if (resource.type !== "file") {
      return res.status(400).json({
        error: "Resource is not a file",
        path,
      });
    }

    /*
     * Ask the storage layer where the file lives.
     */
    const { getFileStream } =
      await import("./storage/storage.js");

    const storage = await getFileStream(resource);

    if (storage.type === "google_drive") {
      const response = await storage.drive.files.get(
        {
          fileId: resource.storage_key,
          alt: "media",
        },
        {
          responseType: "stream",
        }
      );

      const contentType =
        storage.metadata?.mimeType ||
        "application/octet-stream";

      const contentLength =
        storage.metadata?.size != null
          ? String(storage.metadata.size)
          : null;

      const fileName =
        resource.name ||
        decodeURIComponent(
          path.split("/").filter(Boolean).pop() ||
          "download"
        );

      res.setHeader("Content-Type", contentType);

      if (contentLength) {
        res.setHeader("Content-Length", contentLength);
      }

      if (download) {
        res.setHeader(
          "Content-Disposition",
          contentDisposition(fileName, {
            type: "attachment",
          })
        );
      } else {
        res.setHeader(
          "Content-Disposition",
          "inline"
        );
      }

      response.data.on("error", (error) => {
        console.error("Google Drive stream failed:", error);

        if (!res.headersSent) {
          res.status(502).json({
            error: "Google Drive stream failed",
            message: error.message,
          });
        } else {
          res.destroy(error);
        }
      });

      response.data.pipe(res);

      return;
    }

    return res.status(500).json({
      error: "Unsupported storage provider",
      provider: storage.type,
    });

  } catch (error) {
    console.error(
      "File request failed:",
      error
    );

    res.status(500).json({
      error: "Failed to read file",
      message: error.message,
    });
  }
});

app.get("/api/overview", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        d.slug,
        COUNT(r.id) AS count,
        MAX(r.source_modified_at) FILTER (
          WHERE r.source_modified_at <= NOW()
        ) AS latest_update
      FROM departments d
      LEFT JOIN resources r
        ON r.department_id = d.id
        AND r.is_available = TRUE
      GROUP BY d.id, d.slug
      ORDER BY d.id
    `);

    res.json({
      departments: result.rows.map((row) => ({
        slug: row.slug,
        available: true,
        status: 200,
        count: Number(row.count),
        latestUpdate: row.latest_update,
      })),
    });
  } catch (error) {
    console.error("PostgreSQL overview failed:", error);

    res.status(500).json({
      error: "Failed to load overview",
      message: error.message,
    });
  }
});
/*
 * GET /api/search?q=...
 *
 * Recursively searches resources inside all departments.
 */
app.get("/api/search", async (req, res) => {
  try {
    const query = String(req.query.q || "")
      .trim()
      .toLowerCase();

    if (!query) {
      return res.json({
        query: "",
        count: 0,
        results: [],
      });
    }

    /*
     * PostgreSQL handles the search now.
     *
     * The college server is NOT contacted here.
     */
    const searchPattern = `%${query}%`;

    const result = await pool.query(
      `
      SELECT
        d.slug AS department,
        d.name AS department_name,
        r.name,
        r.type,
        r.source_modified_at,
        r.size,
        r.path,
        r.url,
        r.parent_path
      FROM resources r
      INNER JOIN departments d
        ON d.id = r.department_id
      WHERE
        r.is_available = TRUE
        AND LOWER(r.name) LIKE $1
      ORDER BY
        CASE
          WHEN LOWER(r.name) = $2 THEN 1000
          WHEN LOWER(r.name) LIKE $3 THEN 900
          WHEN LOWER(r.name) LIKE $4 THEN 800
          WHEN LOWER(r.name) LIKE $5 THEN 600
          ELSE 400
        END DESC,
        CASE
          WHEN r.type = 'file' THEN 20
          ELSE 0
        END DESC,
        r.source_modified_at DESC NULLS LAST
      LIMIT 500
      `,
      [
        searchPattern,
        query,
        `${query}%`,
        `% ${query}%`,
        `%-${query}%`,
      ]
    );

    const results = result.rows.map((row) => ({
      department: row.department,
      departmentName: row.department_name,
      name: row.name,
      type: row.type,

      /*
       * Keep the API field name expected by the
       * existing React search UI.
       */
      date: row.source_modified_at,

      size: row.size,

      /*
       * Database stores the normalized noticeboard
       * path. React can use this directly.
       */
      path: row.path,

      parentPath: row.parent_path,
    }));

    res.json({
      query,
      count: results.length,
      results,
    });
  } catch (error) {
    console.error("PostgreSQL search failed:", error);

    res.status(500).json({
      error: "Search failed",
      message: error.message,
    });
  }
});

const httpServer = app.listen(PORT, "0.0.0.0", async () => {
  console.log(
    `Backend running on port ${PORT}`
  );

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

  try {
    await ensureMigrationSafetySchema();
  } catch (error) {
    console.error(
      "Failed to ensure migration safety schema:",
      error
    );
  }

  try {
    await ensureMigrationPerformanceIndexes();
  } catch (error) {
    console.error(
      "Failed to ensure migration performance indexes:",
      error
    );
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
      await pool.end();
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
