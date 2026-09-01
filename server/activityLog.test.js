import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "./db/database.js";
import { getAdminActivity, logAdminActivity, ACTIVITY_EVENT_TYPES } from "./activityLog.js";

function withMockedQuery(handler) {
  const original = pool.query;
  pool.query = handler;
  return async (fn) => {
    try {
      return await fn();
    } finally {
      pool.query = original;
    }
  };
}

test("logAdminActivity writes the actor and request context without failing the caller", async () => {
  let captured = null;
  const run = withMockedQuery(async (sql, params) => {
    captured = { sql, params };
    return { rows: [], rowCount: 1 };
  });

  await run(async () => {
    await logAdminActivity({
      req: {
        ip: "127.0.0.1",
        socket: { remoteAddress: "127.0.0.2" },
        headers: {
          "user-agent": "test-agent",
        },
      },
      admin: { id: 7, email: "admin@example.com" },
      eventType: ACTIVITY_EVENT_TYPES.STORAGE_REFRESHED,
      entityType: "storage",
      description: "Refreshed storage",
      metadata: { count: 3 },
    });
  });

  assert.ok(captured.sql.includes("INSERT INTO admin_activity_logs"));
  assert.deepEqual(captured.params.slice(0, 6), [
    7,
    "admin@example.com",
    "storage.refreshed",
    "storage",
    null,
    "Refreshed storage",
  ]);
  assert.equal(JSON.parse(captured.params[6]).count, 3);
  assert.equal(captured.params[7], "127.0.0.1");
  assert.equal(captured.params[8], "test-agent");
});

test("getAdminActivity paginates and maps activity rows", async () => {
  let calls = 0;
  const run = withMockedQuery(async (sql, params) => {
    calls += 1;
    if (calls === 1) return { rows: [{ total: "1" }] };
    assert.match(sql, /LIMIT \$2\s+OFFSET \$3/);
    assert.deepEqual(params, ["storage.refreshed", 50, 0]);
    return {
      rows: [{
        id: "9",
        admin_user_id: "7",
        actor_email: "admin@example.com",
        event_type: "storage.refreshed",
        entity_type: "storage",
        entity_id: null,
        description: "Refreshed storage",
        metadata: { count: 3 },
        ip_address: "127.0.0.1",
        user_agent: "test-agent",
        created_at: "2026-08-30T10:00:00.000Z",
      }],
    };
  });

  await run(async () => {
    const result = await getAdminActivity({
      page: 1,
      pageSize: 50,
      eventType: "storage.refreshed",
    });

    assert.equal(result.pagination.total, 1);
    assert.equal(result.pagination.totalPages, 1);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].id, 9);
    assert.equal(result.entries[0].adminUserId, 7);
    assert.equal(result.entries[0].eventType, "storage.refreshed");
    assert.deepEqual(result.entries[0].metadata, { count: 3 });
  });
});
