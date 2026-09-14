import test from "node:test";
import assert from "node:assert/strict";

import { tryServerSideDriveCopy } from "./migrationDriveCopy.js";

function makeContext(overrides = {}) {
  const calls = {
    copy: [],
    permissionCreate: [],
    permissionDelete: [],
    reconcile: [],
    logs: [],
    heartbeats: 0,
  };

  const targetDrive = {
    files: {
      async copy(...args) {
        calls.copy.push(args);
        return {
          data: {
            id: "target-456",
            name: "sample.xlsx",
            size: "1234",
            mimeType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            md5Checksum: "abc123",
            appProperties: {
              college_noticeboard_migration_item: "item-1",
            },
          },
        };
      },
    },
  };

  const sourceDrive = {
    permissions: {
      async create(...args) {
        calls.permissionCreate.push(args);
        return {
          data: {
            id: "perm-123",
            type: "user",
            role: "reader",
            emailAddress: "target@example.com",
          },
        };
      },
      async delete(...args) {
        calls.permissionDelete.push(args);
      },
    },
  };

  return {
    context: {
      sourceDrive,
      targetDrive,
      targetAccount: { email: "target@example.com" },
      item: {
        id: "item-1",
        source_file_id: "source-123",
        lease_generation: 7,
      },
      sourceMetadata: {
        id: "source-123",
        name: "sample.xlsx",
        size: "1234",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        md5Checksum: "abc123",
        copyRequiresWriterPermission: false,
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
      shareThresholdBytes: 1024,
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
  assert.equal(calls.copy.length, 1);
  assert.equal(calls.permissionCreate.length, 0);
  assert.equal(calls.permissionDelete.length, 0);
  assert.equal(calls.reconcile.length, 0);

  const [request] = calls.copy[0];
  assert.equal(request.fileId, "source-123");
  assert.deepEqual(request.requestBody.parents, ["root"]);
  assert.equal(
    request.requestBody.appProperties.college_noticeboard_migration_item,
    "item-1",
  );
});

test("large 404 temporarily shares source and then copies in Google", async () => {
  const { context, calls } = makeContext();
  let first = true;

  context.targetDrive.files.copy = async (...args) => {
    calls.copy.push(args);
    if (first) {
      first = false;
      const error = new Error("not found");
      error.response = { status: 404 };
      throw error;
    }
    return {
      data: {
        id: "target-789",
        name: "sample.xlsx",
        size: "2000000",
        mimeType: "application/octet-stream",
        md5Checksum: "abc123",
      },
    };
  };

  context.sourceMetadata.size = "2000000";

  const result = await tryServerSideDriveCopy(context);

  assert.equal(result.kind, "copied");
  assert.equal(result.targetFileId, "target-789");
  assert.equal(calls.copy.length, 2);
  assert.equal(calls.permissionCreate.length, 1);
  assert.equal(calls.permissionDelete.length, 1);
  assert.equal(calls.permissionCreate[0][0].fileId, "source-123");
  assert.equal(
    calls.permissionCreate[0][0].requestBody.emailAddress,
    "target@example.com",
  );
  assert.equal(calls.permissionCreate[0][0].requestBody.role, "reader");
  assert.equal(calls.permissionDelete[0][0].permissionId, "perm-123");
});

test("429 is retried with backoff instead of entering reconciliation", async () => {
  const { context, calls } = makeContext();
  let attempts = 0;

  context.targetDrive.files.copy = async (...args) => {
    calls.copy.push(args);
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("rate limited");
      error.response = { status: 429 };
      throw error;
    }

    return {
      data: {
        id: "target-throttle-123",
        name: "sample.xlsx",
        size: "1234",
        mimeType: "application/octet-stream",
        md5Checksum: "abc123",
      },
    };
  };

  const result = await tryServerSideDriveCopy(context);

  assert.equal(result.kind, "copied");
  assert.equal(calls.copy.length, 3);
  assert.equal(calls.reconcile.length, 0);
});

test("403 is reported as unavailable without a second copy", async () => {
  const { context, calls } = makeContext();
  context.targetDrive.files.copy = async (...args) => {
    calls.copy.push(args);
    const error = new Error("forbidden");
    error.response = { status: 403 };
    throw error;
  };

  const result = await tryServerSideDriveCopy(context);

  assert.equal(result.kind, "unavailable");
  assert.equal(calls.copy.length, 1);
  assert.equal(calls.permissionCreate.length, 0);
});

test("small 404 is unavailable without permission churn", async () => {
  const { context, calls } = makeContext();
  context.targetDrive.files.copy = async (...args) => {
    calls.copy.push(args);
    const error = new Error("not found");
    error.response = { status: 404 };
    throw error;
  };

  context.sourceMetadata.size = "512";

  const result = await tryServerSideDriveCopy(context);

  assert.equal(result.kind, "unavailable");
  assert.equal(calls.copy.length, 1);
  assert.equal(calls.permissionCreate.length, 0);
  assert.equal(calls.permissionDelete.length, 0);
});

test("share succeeds but copy remains 404 and cleans permission", async () => {
  const { context, calls } = makeContext();
  context.targetDrive.files.copy = async (...args) => {
    calls.copy.push(args);
    const error = new Error("not found");
    error.response = { status: 404 };
    throw error;
  };
  context.sourceMetadata.size = "2000000";

  const result = await tryServerSideDriveCopy(context);

  assert.equal(result.kind, "unavailable");
  assert.equal(calls.permissionCreate.length, 1);
  assert.equal(calls.permissionDelete.length, 1);
  assert.equal(calls.copy.length, 6);
});

test("copy restriction uses temporary writer access after 404", async () => {
  const { context, calls } = makeContext();
  context.sourceMetadata.size = "2000000";
  context.sourceMetadata.copyRequiresWriterPermission = true;
  let first = true;

  context.targetDrive.files.copy = async (...args) => {
    calls.copy.push(args);
    if (first) {
      first = false;
      const error = new Error("not found");
      error.response = { status: 404 };
      throw error;
    }
    return {
      data: {
        id: "target-writer-123",
        name: "sample.xlsx",
        size: "2000000",
        mimeType: "application/octet-stream",
        md5Checksum: "abc123",
      },
    };
  };

  const result = await tryServerSideDriveCopy(context);

  assert.equal(result.kind, "copied");
  assert.equal(calls.copy.length, 2);
  assert.equal(calls.permissionCreate.length, 1);
  assert.equal(calls.permissionCreate[0][0].requestBody.role, "writer");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.permissionDelete.length, 1);
});

test("ambiguous copy after temporary share cleans permission and reconciles", async () => {
  const { context, calls } = makeContext();
  context.sourceMetadata.size = "2000000";
  let first = true;

  context.targetDrive.files.copy = async (...args) => {
    calls.copy.push(args);
    const error = new Error(first ? "not found" : "service unavailable");
    error.response = { status: first ? 404 : 503 };
    first = false;
    throw error;
  };

  const result = await tryServerSideDriveCopy(context);

  assert.equal(result.kind, "reconciling");
  assert.equal(calls.permissionCreate.length, 1);
  assert.equal(calls.permissionDelete.length, 1);
  assert.equal(calls.copy.length, 2);
  assert.equal(calls.reconcile.length, 1);
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

  assert.equal(result.kind, "unavailable");
  assert.equal(calls.copy.length, 0);
  assert.equal(calls.permissionCreate.length, 0);
  assert.equal(calls.permissionDelete.length, 0);
  assert.equal(calls.reconcile.length, 0);
});
