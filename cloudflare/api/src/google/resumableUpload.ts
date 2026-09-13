const DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files";

const DRIVE_API_URL =
  "https://www.googleapis.com/drive/v3/files";

export const RESUMABLE_CHUNK_BYTES =
  64 * 1024 * 1024;

export type ResumableUploadTarget = {
  id?: string;
  name?: string;
  size?: string;
  mimeType?: string;
  md5Checksum?: string;
  appProperties?: Record<string, string>;
};

export type ResumableUploadResult =
  | {
      kind: "incomplete";
      committedBytes: number;
    }
  | {
      kind: "completed";
      targetFile: ResumableUploadTarget;
    };

export type ResumeStatus =
  | {
      kind: "incomplete";
      committedBytes: number;
    }
  | {
      kind: "completed";
      targetFile: ResumableUploadTarget;
    }
  | {
      kind: "expired";
    };

function authHeaders(
  accessToken: string,
): Headers {
  const headers = new Headers();
  headers.set(
    "Authorization",
    `Bearer ${accessToken}`,
  );
  return headers;
}

function parseRangeEnd(
  rangeHeader: string | null,
): number {
  if (!rangeHeader) {
    return -1;
  }

  const match =
    /^bytes=(\d+)-(\d+)$/.exec(
      rangeHeader.trim(),
    );

  if (!match) {
    throw new Error(
      `Invalid Google resumable upload Range header: ${rangeHeader}`,
    );
  }

  return Number(match[2]);
}

async function responseError(
  response: Response,
  operation: string,
): Promise<Error> {
  let detail = "";

  try {
    const text = await response.text();

    if (text) {
      detail = `: ${text.slice(0, 1000)}`;
    }
  } catch {}

  return new Error(
    `${operation} failed: HTTP ${response.status}${detail}`,
  );
}

export async function createResumableSession({
  accessToken,
  name,
  mimeType,
  totalBytes,
  appProperties,
  signal,
}: {
  accessToken: string;
  name: string;
  mimeType: string;
  totalBytes: number;
  appProperties?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<string> {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new Error(
      `Invalid upload size: ${totalBytes}`,
    );
  }

  const response = await fetch(
    `${DRIVE_UPLOAD_URL}?uploadType=resumable`,
    {
      method: "POST",
      headers: new Headers({
        ...Object.fromEntries(
          authHeaders(accessToken),
        ),
        "Content-Type":
          "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length":
          String(totalBytes),
      }),
      body: JSON.stringify({
        name,
        mimeType,
        parents: ["root"],
        appProperties:
          appProperties ?? undefined,
      }),
      signal,
    },
  );

  if (!response.ok) {
    throw await responseError(
      response,
      "Create resumable upload session",
    );
  }

  const location =
    response.headers.get("Location");

  if (!location) {
    throw new Error(
      "Google Drive did not return a resumable upload session URI",
    );
  }

  return location;
}

export async function queryResumableSession({
  accessToken,
  sessionUrl,
  totalBytes,
  signal,
}: {
  accessToken: string;
  sessionUrl: string;
  totalBytes: number;
  signal?: AbortSignal;
}): Promise<ResumeStatus> {
  const headers =
    authHeaders(accessToken);

  headers.set(
    "Content-Range",
    `bytes */${totalBytes}`,
  );

  const response = await fetch(
    sessionUrl,
    {
      method: "PUT",
      headers,
      signal,
    },
  );

  if (
    response.status === 200 ||
    response.status === 201
  ) {
    return {
      kind: "completed",
      targetFile:
        (await response.json()) as ResumableUploadTarget,
    };
  }

  if (response.status === 308) {
    return {
      kind: "incomplete",
      committedBytes:
        parseRangeEnd(
          response.headers.get("Range"),
        ) + 1,
    };
  }

  if (response.status === 404) {
    return {
      kind: "expired",
    };
  }

  throw await responseError(
    response,
    "Query resumable upload session",
  );
}

export async function uploadChunk({
  accessToken,
  sessionUrl,
  start,
  end,
  totalBytes,
  body,
  mimeType,
  signal,
}: {
  accessToken: string;
  sessionUrl: string;
  start: number;
  end: number;
  totalBytes: number;
  body: ReadableStream<Uint8Array> | null;
  mimeType: string;
  signal?: AbortSignal;
}): Promise<ResumableUploadResult> {
  if (
    start < 0 ||
    end < start ||
    end >= totalBytes
  ) {
    throw new Error(
      `Invalid upload range ${start}-${end}/${totalBytes}`,
    );
  }

  const contentLength =
    end - start + 1;

  const headers =
    authHeaders(accessToken);

  headers.set(
    "Content-Length",
    String(contentLength),
  );

  headers.set(
    "Content-Type",
    mimeType ||
      "application/octet-stream",
  );

  headers.set(
    "Content-Range",
    `bytes ${start}-${end}/${totalBytes}`,
  );

  const response = await fetch(
    sessionUrl,
    {
      method: "PUT",
      headers,
      body,
      signal,
    },
  );

  if (response.status === 308) {
    return {
      kind: "incomplete",
      committedBytes:
        parseRangeEnd(
          response.headers.get("Range"),
        ) + 1,
    };
  }

  if (
    response.status === 200 ||
    response.status === 201
  ) {
    return {
      kind: "completed",
      targetFile:
        (await response.json()) as ResumableUploadTarget,
    };
  }

  throw await responseError(
    response,
    "Upload resumable chunk",
  );
}

export async function downloadDriveRange({
  accessToken,
  fileId,
  start,
  end,
  signal,
}: {
  accessToken: string;
  fileId: string;
  start: number;
  end: number;
  signal?: AbortSignal;
}): Promise<Response> {
  if (start < 0 || end < start) {
    throw new Error(
      `Invalid Drive download range ${start}-${end}`,
    );
  }

  const headers =
    authHeaders(accessToken);

  headers.set(
    "Range",
    `bytes=${start}-${end}`,
  );

  const response = await fetch(
    `${DRIVE_API_URL}/${encodeURIComponent(fileId)}?alt=media`,
    {
      method: "GET",
      headers,
      signal,
    },
  );

  if (
    response.status !== 200 &&
    response.status !== 206
  ) {
    throw await responseError(
      response,
      "Download Drive byte range",
    );
  }

  if (!response.body) {
    throw new Error(
      "Google Drive returned no response body for byte-range download",
    );
  }

  return response;
}
