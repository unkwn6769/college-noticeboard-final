import { strict as assert } from "node:assert";
import test from "node:test";

import { DriveApiError } from "./drive";
import {
  classifyGoogleError,
  isAuthorizationInvalidGoogleError,
} from "./errors";

test("401 is authorization_invalid", () => {
  const error = new DriveApiError(
    "unauthorized",
    401,
    null,
    null,
  );

  assert.equal(
    classifyGoogleError(error).type,
    "authorization_invalid",
  );

  assert.equal(
    isAuthorizationInvalidGoogleError(error),
    true,
  );
});

test("403 invalid credentials is authorization_invalid", () => {
  const error = new DriveApiError(
    "invalid credentials",
    403,
    "invalidCredentials",
    null,
  );

  assert.equal(
    classifyGoogleError(error).type,
    "authorization_invalid",
  );
});

test("429 is transient", () => {
  const error = new DriveApiError(
    "rate limited",
    429,
    "rateLimitExceeded",
    null,
  );

  assert.equal(
    classifyGoogleError(error).type,
    "transient",
  );
});

test("500 is transient", () => {
  const error = new DriveApiError(
    "backend error",
    500,
    "backendError",
    null,
  );

  assert.equal(
    classifyGoogleError(error).type,
    "transient",
  );
});

test("storage quota is storage", () => {
  const error = new DriveApiError(
    "quota exceeded",
    403,
    "storageQuotaExceeded",
    null,
  );

  assert.equal(
    classifyGoogleError(error).type,
    "storage",
  );
});

test("404 file missing is permanent", () => {
  const error = new DriveApiError(
    "file not found",
    404,
    "fileNotFound",
    null,
  );

  assert.equal(
    classifyGoogleError(error).type,
    "permanent",
  );
});

test("network failure without status is ambiguous", () => {
  const error = Object.assign(
    new Error("socket closed"),
    { code: "ECONNRESET" },
  );

  /*
   * Plain network errors are handled as transient by the generic
   * classifier; the copy-specific layer will promote a failed
   * write into reconciliation when the outcome is uncertain.
   */
  assert.equal(
    classifyGoogleError(error).type,
    "transient",
  );
});

test("unknown status is unknown", () => {
  const error = new DriveApiError(
    "unexpected",
    418,
    null,
    null,
  );

  assert.equal(
    classifyGoogleError(error).type,
    "unknown",
  );
});
