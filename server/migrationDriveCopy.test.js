import test from "node:test";
import assert from "node:assert/strict";

import { tryServerSideDriveCopy } from "./migrationDriveCopy.js";

function makeContext(overrides = {}) {
  const calls = {
    get: [],
    copy: [],
    reconcile: [],
    logs: [],
    heartbeats: 0,
  };

  const targetDrive = {
    files: {
      async get(...args) {
        calls.get.push(args);
        return { data: { capabilities: { canCopy: true } } };
      },
      async copy(...args) {
        calls.copy.push(args);
        return {
          data: {
            id: "target-456",
            name: "sample.xlsx",
            size: "1234",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            md5Checksum: "abc123",
            appProperties: { college_noticeboard_migration_item: "item-1" },
            owners: [{ emailAddress: "target@example.com" }],
            parents: ["root"],
          },
        };
      },
    },
  };

  return {
    context: {
      targetDrive,
      targetAccount: { email: "target@example.com" },
      item: { id: "item-1", source_file_id: "source-123", lease_generation: 7 },
      sourceMetadata: {
        id: "source-123",
        name: "sample.xlsx",
        size: "1234",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        md5Checksum: "abc123",
      },
      abortController: new AbortController(),
      ensureHeartbeatStillValid() {
        calls.heartbeats += 1;
      },
      workerNumber: 3,
      log(message) {
        calls.logs.push(message);
      },
      enabled: true,
      markItemReconcilingFn(...args) {
        calls.reconcile.push(args);
      },
      reconciliationDeadlineMs: 60000,
      ...overrides,
    },
    calls,
  };
}

test("successful server-side copy", async () => {
  const { context, calls } = makeContext();
  const result = await tryServerSideDriveCopy(context);

  assert.equal(result.kind, "copied");
  assert.equal(result.targetFileId, "target-456");
  assert.equal(calls.get.length, 1);
  assert.equal(calls.copy.length, 1);
  assert.equal(calls.reconcile.length, 0);

  const [request] = calls.copy[0];
  assert.equal(request.fileId, "source-123");
  assert.deepEqual(request.requestBody.parents, ["root"]);
  assert.equal(
    request.requestBody.appProperties.college_noticeboard_migration_item,
    "item-1",
  );
});

test("canCopy=false falls back without copying", async () => {
  const { context, calls } = makeContext();
  context.targetDrive.files.get = async (...args) => {
    calls.get.push(args);
    return { data: { capabilities: { canCopy: false } } };
  };

  const result = await tryServerSideDriveCopy(context);

  assert.equal(result.kind, "fallback");
  assert.equal(calls.copy.length, 0);
  assert.equal(calls.reconcile.length, 0);
});

test("capability 403 falls back", async () => {
  const { context, calls } = makeContext();
  context.targetDrive.files.get = async (...args) => {
    calls.get.push(args);
    const error = new Error("forbidden");
    error.response = { status: 403 };
    throw error;
  };

  const result = await tryServerSideDriveCopy(context);

  assert.equal(result.kind, "fallback");
  assert.equal(calls.copy.length, 0);
});

test("ambiguous 503 enters reconciliation", async () => {
  const { context, calls } = makeContext();
  context.targetDrive.files.copy = async (...args) => {
    calls.copy.push(args);
    const error = new Error("service unavailable");
    error.response = { status: 503 };
    throw error;
  };

  const result = await tryServerSideDriveCopy(context);

  assert.equal(result.kind, "reconciling");
  assert.equal(calls.reconcile.length, 1);
  assert.match(calls.reconcile[0][2], /uncertain/i);
  assert.equal(calls.reconcile[0][3], 60000);
});

test("missing target ID enters reconciliation", async () => {
  const { context, calls } = makeContext();
  context.targetDrive.files.copy = async (...args) => {
    calls.copy.push(args);
    return { data: { name: "sample.xlsx" } };
  };

  const result = await tryServerSideDriveCopy(context);

  assert.equal(result.kind, "reconciling");
  assert.equal(calls.reconcile.length, 1);
  assert.match(calls.reconcile[0][2], /no target file ID/i);
});

test("disabled feature never touches Drive", async () => {
  const { context, calls } = makeContext({ enabled: false });

  const result = await tryServerSideDriveCopy(context);

  assert.equal(result.kind, "fallback");
  assert.equal(calls.get.length, 0);
  assert.equal(calls.copy.length, 0);
  assert.equal(calls.reconcile.length, 0);
});
