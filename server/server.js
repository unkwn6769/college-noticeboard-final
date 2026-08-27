import express from "express";
import cors from "cors";
import { pool } from "./db/database.js";
import contentDisposition from "content-disposition";

import {
  getGoogleAuthorizationUrl,
  handleGoogleCallback,
  getAdminFromSession,
  deleteAdminSession,
  parseSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  requireAdmin,
} from "./adminAuth.js";
import {
  getConnectedGoogleDriveAccounts,
} from "./storage/googleClient.js";
import {
  getDriveAccountAuthorizationUrl,
  handleDriveAccountCallback,
} from "./driveAccountOAuth.js";

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

// "/api/admin/accounts/:id/status"
app.patch(
  "/api/admin/accounts/:id/status",
  requireAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const status = String(req.body?.status || "").trim();

      if (!["connected", "disabled"].includes(status)) {
        return res.status(400).json({
          error: "Status must be connected or disabled",
        });
      }

      const result = await pool.query(
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

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "Google Drive account not found",
        });
      }

      res.json({
        account: {
          id: result.rows[0].id,
          email: result.rows[0].email,
          status: result.rows[0].status,
          updatedAt: result.rows[0].updated_at,
        },
      });
    } catch (error) {
      console.error(
        "Admin Google account status update failed:",
        error
      );

      res.status(500).json({
        error: "Failed to update Google Drive account status",
      });
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

      await client.query(
        `
        DELETE FROM google_drive_accounts
        WHERE id = $1
        `,
        [id]
      );

      await client.query("COMMIT");

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

      await deleteAdminSession(
        sessionId
      );

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

      await handleDriveAccountCallback(
        String(code || ""),
        String(state || ""),
        sessionId
      );

      const frontendUrl =
        process.env.FRONTEND_URL ||
        "http://localhost:5173";

      res.redirect(
        `${frontendUrl}/admin/accounts`
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on port ${PORT}`);
});