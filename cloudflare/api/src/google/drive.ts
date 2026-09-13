const DRIVE_API_BASE =
  "https://www.googleapis.com/drive/v3";

export type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  md5Checksum?: string;
  appProperties?: Record<string, string>;
  trashed?: boolean;
  copyRequiresWriterPermission?: boolean;
  parents?: string[];
};

export type DrivePermission = {
  id?: string;
  type?: string;
  role?: string;
  emailAddress?: string;
};

export type DriveListResponse = {
  files?: DriveFile[];
  nextPageToken?: string;
};

export class DriveApiError extends Error {
  readonly status: number;
  readonly reason: string | null;
  readonly payload: unknown;

  constructor(
    message: string,
    status: number,
    reason: string | null,
    payload: unknown,
  ) {
    super(message);
    this.name = "DriveApiError";
    this.status = status;
    this.reason = reason;
    this.payload = payload;
  }
}

function isRetryableThrottle(error: unknown): boolean {
  if (!(error instanceof DriveApiError)) {
    return false;
  }

  return (
    error.status === 429 ||
    (
      error.status === 403 &&
      (
        error.reason === "rateLimitExceeded" ||
        error.reason === "userRateLimitExceeded"
      )
    )
  );
}

function retryDelayMs(attempt: number): number {
  const base = [100, 250, 600, 1200][attempt] ?? 1200;
  return base +
    Math.floor(
      Math.random() * Math.min(100, Math.max(10, base / 4)),
    );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseErrorPayload(
  response: Response,
): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const error = (payload as Record<string, unknown>).error;

  if (!error || typeof error !== "object") {
    return null;
  }

  const errors = (error as Record<string, unknown>).errors;

  if (!Array.isArray(errors) || errors.length === 0) {
    return null;
  }

  const first = errors[0];

  if (!first || typeof first !== "object") {
    return null;
  }

  const reason = (first as Record<string, unknown>).reason;

  return typeof reason === "string" ? reason : null;
}

async function driveRequest<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
  retries = 4,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(
      `${DRIVE_API_BASE}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(init.body
            ? { "content-type": "application/json" }
            : {}),
          ...(init.headers || {}),
        },
      },
    );

    if (response.ok) {
      if (response.status === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    }

    const payload = await parseErrorPayload(response);
    const reason = extractReason(payload);

    const error = new DriveApiError(
      `Google Drive API ${response.status}${
        reason ? ` (${reason})` : ""
      }`,
      response.status,
      reason,
      payload,
    );

    if (
      attempt < retries &&
      isRetryableThrottle(error)
    ) {
      await sleep(retryDelayMs(attempt));
      continue;
    }

    throw error;
  }
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, value);
    }
  }

  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

export async function getFile(
  accessToken: string,
  fileId: string,
  fields =
    "id,name,size,mimeType,md5Checksum,appProperties,trashed,copyRequiresWriterPermission",
  signal?: AbortSignal,
): Promise<DriveFile> {
  return driveRequest<DriveFile>(
    accessToken,
    `/files/${encodeURIComponent(fileId)}${query({
      fields,
      supportsAllDrives: "true",
    })}`,
    { signal },
  );
}

export async function listFiles(
  accessToken: string,
  params: {
    q?: string;
    fields?: string;
    pageSize?: number;
    pageToken?: string;
    orderBy?: string;
    spaces?: string;
    includeItemsFromAllDrives?: boolean;
    supportsAllDrives?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<DriveListResponse> {
  return driveRequest<DriveListResponse>(
    accessToken,
    `/files${query({
      q: params.q,
      fields:
        params.fields ??
        "nextPageToken,files(id,name,size,mimeType,md5Checksum,appProperties,trashed,copyRequiresWriterPermission,parents)",
      pageSize:
        params.pageSize === undefined
          ? undefined
          : String(params.pageSize),
      pageToken: params.pageToken,
      orderBy: params.orderBy,
      spaces: params.spaces,
      includeItemsFromAllDrives:
        params.includeItemsFromAllDrives === undefined
          ? undefined
          : String(params.includeItemsFromAllDrives),
      supportsAllDrives:
        params.supportsAllDrives === undefined
          ? "true"
          : String(params.supportsAllDrives),
    })}`,
    { signal: params.signal },
  );
}

export async function copyFile(
  accessToken: string,
  sourceFileId: string,
  body: {
    name?: string;
    parents?: string[];
    appProperties?: Record<string, string>;
  },
  fields =
    "id,name,size,mimeType,md5Checksum,appProperties",
  signal?: AbortSignal,
): Promise<DriveFile> {
  return driveRequest<DriveFile>(
    accessToken,
    `/files/${encodeURIComponent(sourceFileId)}/copy${query({
      supportsAllDrives: "true",
      fields,
    })}`,
    {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    },
  );
}

export async function createPermission(
  accessToken: string,
  fileId: string,
  permission: {
    type: string;
    role: string;
    emailAddress?: string;
    expirationTime?: string;
  },
  signal?: AbortSignal,
): Promise<DrivePermission> {
  return driveRequest<DrivePermission>(
    accessToken,
    `/files/${encodeURIComponent(fileId)}/permissions${query({
      sendNotificationEmail: "false",
      supportsAllDrives: "true",
      fields: "id,type,role,emailAddress",
    })}`,
    {
      method: "POST",
      body: JSON.stringify(permission),
      signal,
    },
  );
}

export async function deletePermission(
  accessToken: string,
  fileId: string,
  permissionId: string,
  signal?: AbortSignal,
): Promise<void> {
  await driveRequest<void>(
    accessToken,
    `/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}${query({
      supportsAllDrives: "true",
    })}`,
    {
      method: "DELETE",
      signal,
    },
  );
}

export async function deleteFile(
  accessToken: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<void> {
  await driveRequest<void>(
    accessToken,
    `/files/${encodeURIComponent(fileId)}${query({
      supportsAllDrives: "true",
    })}`,
    {
      method: "DELETE",
      signal,
    },
  );
}
