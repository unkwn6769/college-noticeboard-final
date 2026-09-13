import assert from "node:assert/strict";
import test from "node:test";

import {
  createResumableSession,
  queryResumableSession,
  uploadChunk,
  downloadDriveRange,
} from "./resumableUpload";

test("createResumableSession returns Google Location", async () => {
  const originalFetch = globalThis.fetch;

  try {
    let method = "";
    let bodyText = "";
    let uploadContentType = "";
    let uploadContentLength = "";

    globalThis.fetch = async (
      input,
      init,
    ) => {
      method = init?.method ?? "GET";

      bodyText = String(
        init?.body ?? "",
      );

      uploadContentType =
        new Headers(
          init?.headers,
        ).get(
          "X-Upload-Content-Type",
        ) ?? "";

      uploadContentLength =
        new Headers(
          init?.headers,
        ).get(
          "X-Upload-Content-Length",
        ) ?? "";

      return new Response(null, {
        status: 200,
        headers: {
          Location:
            "https://upload.example/session-1",
        },
      });
    };

    const session =
      await createResumableSession({
        accessToken: "token",
        name: "example.pdf",
        mimeType: "application/pdf",
        totalBytes: 1234,
        appProperties: {
          college_noticeboard_migration_item:
            "item-1",
        },
      });

    assert.equal(
      session,
      "https://upload.example/session-1",
    );

    assert.equal(
      method,
      "POST",
    );

    assert.equal(
      uploadContentType,
      "application/pdf",
    );

    assert.equal(
      uploadContentLength,
      "1234",
    );

    const body =
      JSON.parse(bodyText) as {
        name?: string;
        mimeType?: string;
        parents?: string[];
        appProperties?: Record<string, string>;
      };

    assert.equal(
      body.name,
      "example.pdf",
    );

    assert.equal(
      body.mimeType,
      "application/pdf",
    );

    assert.deepEqual(
      body.parents,
      ["root"],
    );

    assert.equal(
      body.appProperties
        ?.college_noticeboard_migration_item,
      "item-1",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queryResumableSession parses committed Range", async () => {
  const originalFetch = globalThis.fetch;

  try {
    let range = "";

    globalThis.fetch = async (
      input,
      init,
    ) => {
      range =
        new Headers(
          init?.headers,
        ).get(
          "Content-Range",
        ) ?? "";

      return new Response(null, {
        status: 308,
        headers: {
          Range: "bytes=0-1048575",
        },
      });
    };

    const result =
      await queryResumableSession({
        accessToken: "token",
        sessionUrl:
          "https://upload.example/session-1",
        totalBytes: 2097152,
      });

    assert.equal(
      result.kind,
      "incomplete",
    );

    if (result.kind !== "incomplete") {
      throw new Error(
        "Expected incomplete upload",
      );
    }

    assert.equal(
      result.committedBytes,
      1048576,
    );

    assert.equal(
      range,
      "bytes */2097152",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queryResumableSession detects expired session", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(null, {
        status: 404,
      });

    const result =
      await queryResumableSession({
        accessToken: "token",
        sessionUrl:
          "https://upload.example/session-1",
        totalBytes: 1234,
      });

    assert.deepEqual(
      result,
      {
        kind: "expired",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploadChunk sends correct Content-Range", async () => {
  const originalFetch = globalThis.fetch;

  try {
    let contentLength = "";
    let contentRange = "";
    let receivedBody: Uint8Array | null = null;

    globalThis.fetch = async (
      input,
      init,
    ) => {
      const headers =
        new Headers(init?.headers);

      contentLength =
        headers.get(
          "Content-Length",
        ) ?? "";

      contentRange =
        headers.get(
          "Content-Range",
        ) ?? "";

      if (init?.body instanceof ReadableStream) {
        receivedBody = new Uint8Array(
          await new Response(
            init.body,
          ).arrayBuffer(),
        );
      }

      return new Response(null, {
        status: 308,
        headers: {
          Range:
            "bytes=0-1048575",
        },
      });
    };

    const source =
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new Uint8Array(
              1024,
            ),
          );
          controller.close();
        },
      });

    const result =
      await uploadChunk({
        accessToken: "token",
        sessionUrl:
          "https://upload.example/session-1",
        start: 1048576,
        end: 2097151,
        totalBytes: 4194304,
        body: source,
        mimeType:
          "application/pdf",
      });

    assert.equal(
      result.kind,
      "incomplete",
    );

    assert.equal(
      contentLength,
      "1048576",
    );

    assert.equal(
      contentRange,
      "bytes 1048576-2097151/4194304",
    );

    assert.deepEqual(
      receivedBody,
      new Uint8Array(1024),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploadChunk returns target metadata on completion", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      Response.json(
        {
          id: "target-123",
          name: "example.pdf",
          size: "1234",
          mimeType: "application/pdf",
        },
        {
          status: 200,
        },
      );

    const source =
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new Uint8Array([1, 2, 3]),
          );
          controller.close();
        },
      });

    const result =
      await uploadChunk({
        accessToken: "token",
        sessionUrl:
          "https://upload.example/session-1",
        start: 0,
        end: 2,
        totalBytes: 3,
        body: source,
        mimeType:
          "application/pdf",
      });

    assert.equal(
      result.kind,
      "completed",
    );

    if (result.kind !== "completed") {
      throw new Error(
        "Expected completed upload",
      );
    }

    assert.equal(
      result.targetFile.id,
      "target-123",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadDriveRange sends Range header", async () => {
  const originalFetch = globalThis.fetch;

  try {
    let range = "";
    let requestedUrl = "";

    globalThis.fetch = async (
      input,
      init,
    ) => {
      requestedUrl = String(input);

      range =
        new Headers(
          init?.headers,
        ).get(
          "Range",
        ) ?? "";

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new Uint8Array([1, 2, 3]),
            );
            controller.close();
          },
        }),
        {
          status: 206,
        },
      );
    };

    const response =
      await downloadDriveRange({
        accessToken: "token",
        fileId: "file/123",
        start: 100,
        end: 199,
      });

    assert.equal(
      response.status,
      206,
    );

    assert.equal(
      range,
      "bytes=100-199",
    );

    assert.equal(
      requestedUrl,
      "https://www.googleapis.com/drive/v3/files/file%2F123?alt=media",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
