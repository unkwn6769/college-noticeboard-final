import express from "express";

import cors from "cors";

import { pool } from "./db/database.js";
import contentDisposition from "content-disposition";
const app = express();

app.use(cors());

const PORT = 3001;

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
        return encodeURIComponent(decodeURIComponent(segment));
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
      const headers = {
        Authorization: `Bearer ${storage.apiKey}`,
      };

      const response = await fetch(storage.url, {
        headers,
      });

      if (!response.ok) {
        const message = await response.text().catch(() => "");

        return res.status(response.status).json({
          error: "9Drive returned an error",
          status: response.status,
          message,
          path,
        });
      }

      const contentType =
        response.headers.get("content-type") ||
        "application/octet-stream";

      const contentLength =
        response.headers.get("content-length");

      const fileName =
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

      if (!response.body) {
        return res.end();
      }

      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        res.write(Buffer.from(value));
      }

      return res.end();
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

app.listen(PORT, () => {
  console.log(
    `Backend running at http://localhost:${PORT}`
  );
});