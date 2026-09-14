import { strict as assert } from "node:assert";
import test from "node:test";

import {
  DriveApiError,
} from "./drive";

import {
  tryDriveSideCopy,
} from "./driveCopy";

function sourceMetadata(
  overrides = {},
) {
  return {
    id: "source-1",
    name: "large-file.pdf",
    size: "1048576",
    mimeType: "application/pdf",
    copyRequiresWriterPermission: false,
    ...overrides,
  };
}

function item(
  overrides = {},
) {
  return {
    id: "migration-item-1",
    speed_bytes_per_second: 1000,
    ...overrides,
  };
}

test("404 triggers temporary reader share, copy, and cleanup", async () => {
  const originalFetch =
    globalThis.fetch;

  const calls: Array<{
    url: string;
    method: string;
    body: unknown;
  }> = [];

  let copyAttempt = 0;

  try {
    globalThis.fetch = async (
      input,
      init,
    ) => {
      const url = String(input);
      const method =
        init?.method ?? "GET";

      let body: unknown = null;

      if (init?.body) {
        body = JSON.parse(
          String(init.body),
        );
      }

      calls.push({
        url,
        method,
        body,
      });

      if (
        method === "POST" &&
        url.includes(
          "/files/source-1/copy",
        )
      ) {
        copyAttempt += 1;

        if (copyAttempt === 1) {
          return Response.json(
            {
              error: {
                errors: [
                  { reason: "notFound" },
                ],
              },
            },
            { status: 404 },
          );
        }

        return Response.json({
          id: "target-1",
          name: "large-file.pdf",
        });
      }

      if (
        method === "POST" &&
        url.includes(
          "/files/source-1/permissions",
        )
      ) {
        const permissionBody =
          body as {
            role?: string;
            emailAddress?: string;
            expirationTime?: string;
          };

        assert.equal(
          permissionBody.role,
          "reader",
        );

        assert.equal(
          permissionBody.emailAddress,
          "target@example.test",
        );

        assert.ok(
          permissionBody.expirationTime,
        );

        return Response.json({
          id: "permission-1",
        });
      }

      if (
        method === "DELETE" &&
        url.includes(
          "/files/source-1/permissions/permission-1",
        )
      ) {
        return new Response(null, {
          status: 204,
        });
      }

      throw new Error(
        `Unexpected request: ${method} ${url}`,
      );
    };

    const result =
      await tryDriveSideCopy({
        sourceAccessToken:
          "source-token",
        targetAccessToken:
          "target-token",
        sourceMetadata:
          sourceMetadata(),
        targetAccount: {
          email:
            "target@example.test",
        },
        item: item(),
      });

    assert.equal(
      result.kind,
      "copied",
    );

    assert.equal(
      result.targetFile.id,
      "target-1",
    );

    assert.equal(
      copyAttempt,
      2,
    );

    const deleteCalls =
      calls.filter(
        (call) =>
          call.method === "DELETE",
      );

    assert.equal(
      deleteCalls.length,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("restricted source uses temporary writer access", async () => {
  const originalFetch = globalThis.fetch;

  let permissionRole = "";
  let copyAttempts = 0;

  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        method === "POST" &&
        url.includes("/files/source-1/copy")
      ) {
        copyAttempts += 1;

        if (copyAttempts === 1) {
          return Response.json(
            {
              error: {
                errors: [
                  { reason: "notFound" },
                ],
              },
            },
            { status: 404 },
          );
        }

        return Response.json({
          id: "target-writer-1",
          name: "large-file.pdf",
        });
      }

      if (
        method === "POST" &&
        url.includes("/files/source-1/permissions")
      ) {
        const body = JSON.parse(
          String(init?.body ?? ""),
        );

        permissionRole = body.role;

        return Response.json({
          id: "permission-writer",
        });
      }

      if (
        method === "DELETE" &&
        url.includes("/permissions/permission-writer")
      ) {
        return new Response(null, {
          status: 204,
        });
      }

      throw new Error(
        `Unexpected request: ${method} ${url}`,
      );
    };

    const result = await tryDriveSideCopy({
      sourceAccessToken: "source-token",
      targetAccessToken: "target-token",
      sourceMetadata: sourceMetadata({
        copyRequiresWriterPermission: true,
      }),
      targetAccount: {
        email: "target@example.test",
      },
      item: item(),
    });

    assert.equal(result.kind, "copied");
    assert.equal(result.targetFile.id, "target-writer-1");
    assert.equal(permissionRole, "writer");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cannotSetExpiration retries temporary sharing without expiration", async () => {
  const originalFetch = globalThis.fetch;
  const permissionBodies: Record<string, unknown>[] = [];
  let copyAttempts = 0;
  let deleteCount = 0;

  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (method === "POST" && url.includes("/files/source-1/copy")) {
        copyAttempts += 1;
        if (copyAttempts === 1) {
          return Response.json(
            { error: { errors: [{ reason: "notFound" }] } },
            { status: 404 },
          );
        }
        return Response.json({ id: "target-no-expiration", name: "large-file.pdf" });
      }

      if (method === "POST" && url.includes("/files/source-1/permissions")) {
        const body = JSON.parse(String(init?.body ?? ""));
        permissionBodies.push(body);
        if (permissionBodies.length === 1) {
          return Response.json(
            { error: { errors: [{ reason: "cannotSetExpiration" }] } },
            { status: 403 },
          );
        }
        return Response.json({ id: "permission-no-expiration" });
      }

      if (
        method === "DELETE" &&
        url.includes("/permissions/permission-no-expiration")
      ) {
        deleteCount += 1;
        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    const result = await tryDriveSideCopy({
      sourceAccessToken: "source-token",
      targetAccessToken: "target-token",
      sourceMetadata: sourceMetadata(),
      targetAccount: { email: "target@example.test" },
      item: item(),
    });

    assert.equal(result.kind, "copied");
    assert.equal(permissionBodies.length, 2);
    assert.ok(permissionBodies[0].expirationTime);
    assert.equal(permissionBodies[1].expirationTime, undefined);
    assert.equal(deleteCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("temporary permission cleanup failure is surfaced", async () => {
  const originalFetch = globalThis.fetch;
  let copyAttempts = 0;

  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (method === "POST" && url.includes("/files/source-1/copy")) {
        copyAttempts += 1;
        if (copyAttempts === 1) {
          return Response.json(
            { error: { errors: [{ reason: "notFound" }] } },
            { status: 404 },
          );
        }
        return Response.json({ id: "target-cleanup-failure" });
      }

      if (method === "POST" && url.includes("/files/source-1/permissions")) {
        return Response.json({ id: "permission-cleanup-failure" });
      }

      if (
        method === "DELETE" &&
        url.includes("/permissions/permission-cleanup-failure")
      ) {
        return Response.json(
          { error: { errors: [{ reason: "forbidden" }] } },
          { status: 403 },
        );
      }

      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    await assert.rejects(
      () =>
        tryDriveSideCopy({
          sourceAccessToken: "source-token",
          targetAccessToken: "target-token",
          sourceMetadata: sourceMetadata(),
          targetAccount: { email: "target@example.test" },
          item: item(),
        }),
      /Temporary source permission cleanup failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("small 404 falls back without sharing", async () => {
  const originalFetch =
    globalThis.fetch;

  let permissionCalls = 0;

  try {
    globalThis.fetch = async (
      input,
      init,
    ) => {
      const url = String(input);
      const method =
        init?.method ?? "GET";

      if (
        method === "POST" &&
        url.includes(
          "/files/source-1/copy",
        )
      ) {
        return Response.json(
          {
            error: {
              errors: [
                { reason: "notFound" },
              ],
            },
          },
          { status: 404 },
        );
      }

      if (
        url.includes(
          "/files/source-1/permissions",
        )
      ) {
        permissionCalls += 1;
      }

      throw new Error(
        `Unexpected request: ${method} ${url}`,
      );
    };

    const result =
      await tryDriveSideCopy({
        sourceAccessToken:
          "source-token",
        targetAccessToken:
          "target-token",
        sourceMetadata:
          sourceMetadata({
            size: "1000",
          }),
        targetAccount: {
          email:
            "target@example.test",
        },
        item: item({
          speed_bytes_per_second: 0,
        }),
      });

    assert.equal(
      result.kind,
      "fallback",
    );

    assert.equal(
      permissionCalls,
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("temporary permission is cleaned up when the shared copy fails", async () => {
  const originalFetch = globalThis.fetch;

  let deleteCount = 0;
  let copyCount = 0;

  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        method === "POST" &&
        url.includes("/files/source-1/copy")
      ) {
        copyCount += 1;

        if (copyCount === 1) {
          return Response.json(
            {
              error: {
                errors: [
                  { reason: "notFound" },
                ],
              },
            },
            { status: 404 },
          );
        }

        return Response.json(
          {
            error: {
              errors: [
                { reason: "backendError" },
              ],
            },
          },
          { status: 503 },
        );
      }

      if (
        method === "POST" &&
        url.includes("/files/source-1/permissions")
      ) {
        return Response.json({
          id: "permission-cleanup-test",
        });
      }

      if (
        method === "DELETE" &&
        url.includes(
          "/permissions/permission-cleanup-test",
        )
      ) {
        deleteCount += 1;

        return new Response(null, {
          status: 204,
        });
      }

      throw new Error(
        `Unexpected request: ${method} ${url}`,
      );
    };

    await assert.rejects(
      () =>
        tryDriveSideCopy({
          sourceAccessToken: "source-token",
          targetAccessToken: "target-token",
          sourceMetadata: sourceMetadata(),
          targetAccount: {
            email: "target@example.test",
          },
          item: item(),
        }),
    );

    assert.ok(copyCount > 0);
    assert.equal(deleteCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("429 is retried by the copy path before succeeding", async () => {
  const originalFetch = globalThis.fetch;

  let copyCount = 0;

  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        method === "POST" &&
        url.includes("/files/source-1/copy")
      ) {
        copyCount += 1;

        if (copyCount === 1) {
          return Response.json(
            {
              error: {
                errors: [
                  {
                    reason:
                      "rateLimitExceeded",
                  },
                ],
              },
            },
            { status: 429 },
          );
        }

        return Response.json({
          id: "throttle-retry-target",
          name: "large-file.pdf",
        });
      }

      throw new Error(
        `Unexpected request: ${method} ${url}`,
      );
    };

    const result = await tryDriveSideCopy({
      sourceAccessToken: "source-token",
      targetAccessToken: "target-token",
      sourceMetadata: sourceMetadata(),
      targetAccount: {
        email: "target@example.test",
      },
      item: item(),
    });

    assert.equal(result.kind, "copied");
    assert.equal(
      result.targetFile.id,
      "throttle-retry-target",
    );
    assert.equal(copyCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("403 rateLimitExceeded is retried by the copy path", async () => {
  const originalFetch = globalThis.fetch;

  let copyCount = 0;

  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        method === "POST" &&
        url.includes("/files/source-1/copy")
      ) {
        copyCount += 1;

        if (copyCount === 1) {
          return Response.json(
            {
              error: {
                errors: [
                  {
                    reason:
                      "rateLimitExceeded",
                  },
                ],
              },
            },
            { status: 403 },
          );
        }

        return Response.json({
          id: "rate-limit-target",
          name: "large-file.pdf",
        });
      }

      throw new Error(
        `Unexpected request: ${method} ${url}`,
      );
    };

    const result = await tryDriveSideCopy({
      sourceAccessToken: "source-token",
      targetAccessToken: "target-token",
      sourceMetadata: sourceMetadata(),
      targetAccount: {
        email: "target@example.test",
      },
      item: item(),
    });

    assert.equal(result.kind, "copied");
    assert.equal(
      result.targetFile.id,
      "rate-limit-target",
    );
    assert.equal(copyCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
