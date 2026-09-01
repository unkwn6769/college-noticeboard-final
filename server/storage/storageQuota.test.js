import assert from "node:assert/strict";
import test from "node:test";
import { aggregateQuota } from "./storageQuotaMath.js";

test("aggregates connected account quotas without double counting", () => {
  const summary = aggregateQuota([
    {
      id: "a",
      email: "a@example.com",
      status: "connected",
      limitBytes: "107374182400",
      usageBytes: "42949672960",
      lastSuccessfulRefreshAt: "2026-08-30T05:00:00.000Z",
      lastError: null,
    },
    {
      id: "b",
      email: "b@example.com",
      status: "connected",
      limitBytes: "214748364800",
      usageBytes: "107374182400",
      lastSuccessfulRefreshAt: "2026-08-30T06:00:00.000Z",
      lastError: null,
    },
    {
      id: "c",
      email: "c@example.com",
      status: "authorization_invalid",
      limitBytes: "999",
      usageBytes: "100",
      lastSuccessfulRefreshAt: "2026-08-30T06:30:00.000Z",
      lastError: null,
    },
  ]);

  assert.equal(summary.totalCapacityBytes, "322122547200");
  assert.equal(summary.totalUsedBytes, "150323855360");
  assert.equal(summary.totalFreeBytes, "171798691840");
  assert.equal(summary.knownAccounts, 2);
  assert.equal(summary.unavailableAccounts, 0);
  assert.equal(summary.complete, true);
  assert.equal(summary.lastSuccessfulRefreshAt, "2026-08-30T06:00:00.000Z");
  assert.equal(summary.accounts[2].quotaAvailable, false);
});

test("marks connected account quota failures as incomplete rather than treating them as zero", () => {
  const summary = aggregateQuota([
    {
      id: "a",
      email: "a@example.com",
      status: "connected",
      limitBytes: null,
      usageBytes: null,
      lastSuccessfulRefreshAt: null,
      lastError: "quota unavailable",
    },
  ]);

  assert.equal(summary.totalCapacityBytes, "0");
  assert.equal(summary.totalUsedBytes, "0");
  assert.equal(summary.unavailableAccounts, 1);
  assert.equal(summary.complete, false);
  assert.equal(summary.accounts[0].quotaAvailable, false);
});
