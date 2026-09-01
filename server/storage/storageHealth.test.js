import assert from "node:assert/strict";
import test from "node:test";
import { classifyStorageHealth } from "./storageHealth.js";

test("classifies a fresh connected quota as healthy", () => {
  assert.equal(
    classifyStorageHealth({
      status: "connected",
      capacityBytes: "100",
      usageBytes: "40",
      lastSuccessfulRefreshAt: "2026-08-31T10:00:00Z",
      lastError: null,
    }),
    "healthy"
  );
});

test("classifies a previously successful account with a refresh error as stale", () => {
  assert.equal(
    classifyStorageHealth({
      status: "connected",
      capacityBytes: "100",
      usageBytes: "40",
      lastSuccessfulRefreshAt: "2026-08-31T10:00:00Z",
      lastError: "quota timeout",
    }),
    "stale"
  );
});

test("distinguishes unavailable and authorization-invalid accounts", () => {
  assert.equal(
    classifyStorageHealth({
      status: "connected",
      capacityBytes: null,
      usageBytes: null,
      lastSuccessfulRefreshAt: null,
      lastError: "quota unavailable",
    }),
    "unavailable"
  );

  assert.equal(
    classifyStorageHealth({
      status: "authorization_invalid",
      capacityBytes: null,
      usageBytes: null,
      lastSuccessfulRefreshAt: null,
      lastError: "401",
    }),
    "authorization_invalid"
  );
});
