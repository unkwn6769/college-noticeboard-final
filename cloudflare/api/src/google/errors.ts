import { DriveApiError } from "./drive";

export type GoogleErrorClass =
  | {
      type: "authorization_invalid";
      reason: string;
    }
  | {
      type: "transient";
      reason: string;
    }
  | {
      type: "storage";
      reason: string;
    }
  | {
      type: "permanent";
      reason: string;
    }
  | {
      type: "ambiguous";
      reason: string;
    }
  | {
      type: "unknown";
      reason: string;
    };

function getStatus(error: unknown): number {
  if (error instanceof DriveApiError) {
    return error.status;
  }

  if (!error || typeof error !== "object") {
    return 0;
  }

  const value = error as Record<string, unknown>;

  return Number(
    value.status ??
      value.code ??
      0,
  ) || 0;
}

function getReason(error: unknown): string | null {
  if (error instanceof DriveApiError) {
    return error.reason;
  }

  if (!error || typeof error !== "object") {
    return null;
  }

  const value = error as Record<string, unknown>;

  return typeof value.reason === "string"
    ? value.reason
    : null;
}

function getCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const value = error as Record<string, unknown>;

  return typeof value.code === "string"
    ? value.code
    : null;
}

function getMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error ?? "");
}

export function classifyGoogleError(
  error: unknown,
): GoogleErrorClass {
  const status = getStatus(error);
  const reason = getReason(error);
  const code = getCode(error);
  const message = getMessage(error);

  const normalized = String(
    reason ??
      code ??
      message ??
      "",
  ).toLowerCase();

  /*
   * OAuth / account authorization failures.
   */
  if (
    status === 401 ||
    (
      status === 403 &&
      (
        reason === "notAuthorized" ||
        reason === "invalidCredentials" ||
        reason === "invalid_grant" ||
        reason === "invalid_client" ||
        normalized.includes("invalid grant") ||
        normalized.includes("invalid credentials") ||
        normalized.includes("not authorized") ||
        normalized.includes("invalid_client") ||
        normalized.includes("unauthorized_client") ||
        normalized.includes("required scope")
      )
    )
  ) {
    return {
      type: "authorization_invalid",
      reason:
        reason ??
        code ??
        `HTTP ${status}`,
    };
  }

  /*
   * Storage/quota failures need another destination-capacity check,
   * not a generic retry.
   */
  if (
    reason === "storageQuotaExceeded" ||
    reason === "quotaExceeded" ||
    status === 507
  ) {
    return {
      type: "storage",
      reason:
        reason ??
        `HTTP ${status}`,
    };
  }

  /*
   * Persistent ambiguity is handled separately from ordinary
   * transient retries. This is especially important for copy:
   * the remote operation may have succeeded even though the
   * response failed.
   */
  if (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500 ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return {
      type: "transient",
      reason:
        reason ??
        code ??
        `HTTP ${status}`,
    };
  }

  /*
   * These are deterministic request/object/permission failures.
   */
  if (
    status === 400 ||
    status === 404 ||
    status === 405 ||
    status === 410 ||
    status === 412 ||
    reason === "insufficientFilePermissions" ||
    reason === "forbidden" ||
    reason === "fileNotFound" ||
    reason === "notFound" ||
    reason === "invalid"
  ) {
    return {
      type: "permanent",
      reason:
        reason ??
        `HTTP ${status}`,
    };
  }

  /*
   * A fetch/network error without a meaningful status is
   * potentially ambiguous for a write operation. Keep it
   * separate so the migration processor can reconcile instead
   * of creating a duplicate.
   */
  if (status === 0) {
    return {
      type: "ambiguous",
      reason:
        reason ??
        code ??
        (message || "unknown network failure"),
    };
  }

  return {
    type: "unknown",
    reason:
      reason ??
      code ??
      (status
        ? `HTTP ${status}`
        : message || "unknown"),
  };
}

export function isAuthorizationInvalidGoogleError(
  error: unknown,
): boolean {
  return (
    classifyGoogleError(error).type ===
    "authorization_invalid"
  );
}
