import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  copyFile,
  createPermission,
  deleteFile,
  deletePermission,
  getFile,
  listFiles,
} from "./drive";

function mockResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(
    body === undefined
      ? null
      : JSON.stringify(body),
    {
      status,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

test("getFile builds a Drive files.get request", async () => {
  const originalFetch = globalThis.fetch;

  try {
    let requestUrl = "";
    let authorization = "";

    globalThis.fetch = async (
      input,
      init,
    ) => {
      requestUrl = String(input);
      authorization = String(
        new Headers(init?.headers).get("authorization"),
      );

      return mockResponse({
        id: "source-1",
        name: "example.pdf",
      });
    };

    const file = await getFile(
      "token-123",
      "source-1",
    );

    assert.equal(file.id, "source-1");
    assert.match(
      requestUrl,
      /\/files\/source-1\?/,
    );
    assert.match(
      requestUrl,
      /supportsAllDrives=true/,
    );
    assert.match(
      authorization,
      /^Bearer token-123$/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("copyFile sends Google-side copy metadata", async () => {
  const originalFetch = globalThis.fetch;

  try {
    let requestBody = "";
    let requestMethod = "";

    globalThis.fetch = async (
      input,
      init,
    ) => {
      requestMethod = init?.method ?? "GET";
      requestBody = String(init?.body ?? "");

      return mockResponse({
        id: "target-1",
        name: "example.pdf",
      });
    };

    const result = await copyFile(
      "token-123",
      "source-1",
      {
        name: "example.pdf",
        parents: ["root"],
        appProperties: {
          college_noticeboard_migration_item:
            "item-1",
        },
      },
    );

    assert.equal(result.id, "target-1");
    assert.equal(requestMethod, "POST");

    const body = JSON.parse(requestBody);

    assert.deepEqual(body, {
      name: "example.pdf",
      parents: ["root"],
      appProperties: {
        college_noticeboard_migration_item:
          "item-1",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createPermission sends temporary user access", async () => {
  const originalFetch = globalThis.fetch;

  try {
    let requestBody = "";

    globalThis.fetch = async (
      input,
      init,
    ) => {
      requestBody = String(init?.body ?? "");
      return mockResponse({ id: "perm-1" });
    };

    const result = await createPermission(
      "token-123",
      "source-1",
      {
        type: "user",
        role: "reader",
        emailAddress: "target@example.com",
      },
    );

    assert.equal(result.id, "perm-1");

    const body = JSON.parse(requestBody);

    assert.equal(body.type, "user");
    assert.equal(body.role, "reader");
    assert.equal(
      body.emailAddress,
      "target@example.com",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listFiles supports migration-marker queries", async () => {
  const originalFetch = globalThis.fetch;

  try {
    let requestUrl = "";

    globalThis.fetch = async (input) => {
      requestUrl = String(input);

      return mockResponse({
        files: [
          {
            id: "target-1",
            appProperties: {
              college_noticeboard_migration_item:
                "item-1",
            },
          },
        ],
      });
    };

    const result = await listFiles(
      "token-123",
      {
        q:
          "appProperties has { key='college_noticeboard_migration_item' and value='item-1' } and trashed = false",
        pageSize: 10,
      },
    );

    assert.equal(result.files?.length, 1);
    assert.match(
      requestUrl,
      /appProperties\+has\+/,
    );
    assert.match(
      requestUrl,
      /trashed\+%3D\+false/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deletePermission uses DELETE", async () => {
  const originalFetch = globalThis.fetch;

  try {
    let method = "";

    globalThis.fetch = async (
      input,
      init,
    ) => {
      method = init?.method ?? "GET";
      return mockResponse(undefined, 204);
    };

    await deletePermission(
      "token-123",
      "source-1",
      "perm-1",
    );

    assert.equal(method, "DELETE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deleteFile uses DELETE", async () => {
  const originalFetch = globalThis.fetch;

  try {
    let method = "";

    globalThis.fetch = async (
      input,
      init,
    ) => {
      method = init?.method ?? "GET";
      return mockResponse(undefined, 204);
    };

    await deleteFile(
      "token-123",
      "target-1",
    );

    assert.equal(method, "DELETE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
