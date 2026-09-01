import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSourceRetentionFilters } from "./sourceRetention.js";

test("source-retention filter normalization clamps page size and rejects unknown cleanup states", () => {
  const filters = normalizeSourceRetentionFilters({
    page: "4",
    pageSize: "1000",
    sourceDeleteStatus: "failed",
    itemStatus: "completed",
    accountId: "account-1",
    search: "  source.pdf  ",
  });

  assert.equal(filters.page, 4);
  assert.equal(filters.pageSize, 100);
  assert.equal(filters.sourceDeleteStatus, "failed");
  assert.equal(filters.itemStatus, "completed");
  assert.equal(filters.accountId, "account-1");
  assert.equal(filters.search, "source.pdf");

  const invalid = normalizeSourceRetentionFilters({
    sourceDeleteStatus: "deleted",
  });

  assert.equal(invalid.sourceDeleteStatus, "");
});
