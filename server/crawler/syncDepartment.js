import { pool } from "../db/database.js";
import { parseDirectory } from "../parser.js";

const COLLEGE_SERVER = "http://10.24.14.231";

const MAX_DEPTH = 10;
const REQUEST_TIMEOUT = 15000;

async function fetchDirectory(url) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        items: null,
        error: `College server returned ${response.status}`,
      };
    }

    const html = await response.text();

    return {
      ok: true,
      status: response.status,
      items: parseDirectory(html, url),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      items: null,
      error: error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncDepartment(slug, syncRunId) {
  const departmentResult = await pool.query(
    `
    SELECT id
    FROM departments
    WHERE slug = $1
    `,
    [slug]
  );

  if (departmentResult.rows.length === 0) {
    throw new Error(`Department not found: ${slug}`);
  }

  const departmentId = departmentResult.rows[0].id;
  const syncStartedAt = new Date();

  const rootPath = `/noticeboards/${slug}/`;
  const rootUrl = `${COLLEGE_SERVER}${rootPath}`;

  const queue = [
    {
      url: rootUrl,
      path: rootPath,
      depth: 0,
    },
  ];

  const visited = new Set();
  const successfulDirectories = new Set();
  const failedDirectories = new Set();

  const resources = [];

  let directoriesScanned = 0;
  let httpErrors = 0;
  let fetchErrors = 0;

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    if (visited.has(current.url)) {
      continue;
    }

    visited.add(current.url);

    if (current.depth > MAX_DEPTH) {
      continue;
    }

    const result = await fetchDirectory(current.url);

    /*
     * Directory failed.
     */
    if (!result.ok) {
      failedDirectories.add(current.path);

      if (result.status !== null) {
        httpErrors++;
      } else {
        fetchErrors++;
      }

      if (current.path === rootPath) {
        await pool.query(
          `UPDATE departments
            SET
              status = $1,
              updated_at = NOW()
            WHERE id = $2
            `,
          [
            result.status || 500,
            departmentId,
          ]
        );
      }

      await pool.query(
        `
        INSERT INTO sync_errors (
          sync_run_id,
          department,
          path,
          status,
          message
        )
        VALUES ($1, $2, $3, $4, $5)
        `,
        [
          syncRunId,
          slug,
          current.path,
          result.status,
          result.error ||
          `Failed to fetch ${current.url}`,
        ]
      );

      continue;
    }

    /*
     * Directory succeeded.
     */
    successfulDirectories.add(current.path);
    directoriesScanned++;

    for (const item of result.items || []) {
      const itemPath = new URL(item.url).pathname;

      const sourceDate = new Date(item.date);

      resources.push({
        departmentId,
        name: item.name,
        type: item.type,
        path: itemPath,
        url: item.url,
        parentPath: current.path,
        size: item.size,
        sourceModifiedAt:
          Number.isNaN(sourceDate.getTime())
            ? null
            : sourceDate,
      });

      /*
       * Queue child folders.
       */
      if (
        item.type === "folder" &&
        current.depth < MAX_DEPTH &&
        !visited.has(item.url)
      ) {
        queue.push({
          url: item.url,
          path: itemPath,
          depth: current.depth + 1,
        });
      }
    }
  }

  /*
   * PostgreSQL transaction.
   */
  const client = await pool.connect();

  let added = 0;
  let updated = 0;
  let removed = 0;

  try {
    await client.query("BEGIN");

    /*
     * Temporary table for this crawl.
     */
    await client.query(`
      CREATE TEMP TABLE sync_resources (
        department_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        path TEXT NOT NULL,
        url TEXT NOT NULL,
        parent_path TEXT,
        size BIGINT,
        source_modified_at TIMESTAMPTZ
      ) ON COMMIT DROP
    `);

    /*
     * Populate temporary table.
     */
    for (const resource of resources) {
      await client.query(
        `
        INSERT INTO sync_resources (
          department_id,
          name,
          type,
          path,
          url,
          parent_path,
          size,
          source_modified_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [
          resource.departmentId,
          resource.name,
          resource.type,
          resource.path,
          resource.url,
          resource.parentPath,
          resource.size,
          resource.sourceModifiedAt,
        ]
      );
    }

    /*
     * Count new resources.
     */
    const addedResult = await client.query(`
      SELECT COUNT(*)::INTEGER AS count
      FROM sync_resources s
      LEFT JOIN resources r
        ON r.path = s.path
      WHERE r.id IS NULL
    `);

    added = addedResult.rows[0].count;

    /*
     * Count existing resources.
     */
    const updatedResult = await client.query(`
      SELECT COUNT(*)::INTEGER AS count
      FROM sync_resources s
      INNER JOIN resources r
        ON r.path = s.path
    `);

    updated = updatedResult.rows[0].count;

    /*
 * Insert new resources.
 *
 * New files start in the college storage state.
 * The storage worker will later upload them to 9Drive.
 */
    await client.query(`
  INSERT INTO resources (
    department_id,
    name,
    type,
    path,
    url,
    parent_path,
    size,
    source_modified_at,
    first_seen_at,
    last_seen_at,
    is_available,
    crawl_status,
    storage_provider,
    storage_status
  )
  SELECT
    department_id,
    name,
    type,
    path,
    url,
    parent_path,
    size,
    source_modified_at,
    NOW(),
    NOW(),
    TRUE,
    'ok',
    CASE
      WHEN type = 'file' THEN 'college'
      ELSE NULL
    END,
    CASE
      WHEN type = 'file' THEN 'pending'
      ELSE NULL
    END
  FROM sync_resources
  ON CONFLICT (path) DO NOTHING
`);

    /*
     * Determine files that need cloud storage synchronization.
     *
     * Queue:
     *   - new files
     *   - changed files
     *   - files that are not currently synced
     *
     * Exclude junk, temporary files, shortcuts,
     * and zero-byte files.
     */
    const storageQueueResult = await client.query(`
  SELECT
    s.department_id,
    s.name,
    s.type,
    s.path,
    s.url,
    s.parent_path,
    s.size,
    s.source_modified_at,
    r.id AS id,
    r.storage_provider,
    r.storage_key,
    r.storage_status
  FROM sync_resources s
  LEFT JOIN resources r
    ON r.path = s.path
  WHERE
    s.type = 'file'
    AND s.size > 0

    AND LOWER(s.name) NOT IN (
      'thumbs.db',
      'desktop.ini',
      '.ds_store'
    )

    AND s.name NOT LIKE '~$%'
    AND s.name NOT LIKE '.~%'
    AND s.name NOT LIKE '._%'
    AND LOWER(s.name) NOT LIKE '%.lnk'
    AND LOWER(s.name) NOT LIKE '%.tmp'
    AND (
  r.id IS NULL
  OR r.size IS DISTINCT FROM s.size
  OR r.source_modified_at IS DISTINCT FROM s.source_modified_at
  OR r.storage_status IN ('pending', 'failed')
)

  ORDER BY s.path
`);

    const storageQueue = storageQueueResult.rows;

    console.log(
      `Storage queue: ${storageQueue.length} file(s)`
    );

    /*
     * Update existing resources.
     */
    await client.query(`
      UPDATE resources r
      SET
        department_id = s.department_id,
        name = s.name,
        type = s.type,
        url = s.url,
        parent_path = s.parent_path,
        size = s.size,
        source_modified_at = s.source_modified_at,
        last_seen_at = NOW(),
        is_available = TRUE,
        crawl_status = 'ok',
        updated_at = NOW()
      FROM sync_resources s
      WHERE r.path = s.path
    `);

    /*
     * Safely detect missing resources.
     *
     * Only resources whose parent directory was
     * successfully crawled can be marked unavailable.
     */
    for (const parentPath of successfulDirectories) {
      const result = await client.query(
        `
        UPDATE resources
        SET
          is_available = FALSE,
          updated_at = NOW()
        WHERE department_id = $1
          AND parent_path = $2
          AND last_seen_at < $3
          AND is_available = TRUE
        `,
        [
          departmentId,
          parentPath,
          syncStartedAt,
        ]
      );

      removed += result.rowCount;
    }

    /*
     * Resources under failed directories are left
     * available and untouched.
     */
    for (const parentPath of failedDirectories) {
      await client.query(
        `
        UPDATE resources
        SET
          crawl_status = 'http_error'
        WHERE department_id = $1
          AND parent_path = $2
          AND last_seen_at < $3
        `,
        [
          departmentId,
          parentPath,
          syncStartedAt,
        ]
      );
    }

    /*
     * Update department status only when root
     * directory was successfully crawled.
     */
    const rootWasSuccessful =
      successfulDirectories.has(rootPath);

    if (rootWasSuccessful) {
      await client.query(
        `
        UPDATE departments
        SET
          status = 200,
          last_successful_sync = NOW(),
          updated_at = NOW()
        WHERE id = $1
        `,
        [departmentId]
      );
    }

    await client.query("COMMIT");

    return {
      slug,
      directoriesScanned,
      successfulDirectories:
        successfulDirectories.size,
      failedDirectories:
        failedDirectories.size,
      resourcesFound: resources.length,
      added,
      updated,
      removed,
      httpErrors,
      fetchErrors,
      storageQueue,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}