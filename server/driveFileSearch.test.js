import assert from "node:assert/strict";
import test from "node:test";
import { buildDriveFileSearchWhere, normalizeDriveFileSearchFilters } from "./driveFileSearch.js";

test("builds parameterized search filters without loading the file inventory", () => {
  const filters = normalizeDriveFileSearchFilters({
    q: "Exam 2024%_",
    accountId: "account-1",
    fileType: "pdf",
    status: "synced",
    available: "available",
  });

  const result = buildDriveFileSearchWhere(filters);

  assert.deepEqual(result.values, ["%Exam 2024\\%\\_%", "account-1", "synced"]);
  assert.match(result.clauses[1], /ILIKE/);
  assert.match(result.clauses[2], /account_id/);
  assert.match(result.clauses[3], /\\.pdf\$/);
  assert.match(result.clauses[4], /storage_status/);
  assert.match(result.clauses[5], /is_available = TRUE/);
});

test("rejects invalid filters", () => {
  assert.throws(
    () => buildDriveFileSearchWhere(normalizeDriveFileSearchFilters({ fileType: "unknown-type" })),
    /Invalid file type filter/
  );

  assert.throws(
    () => buildDriveFileSearchWhere(normalizeDriveFileSearchFilters({ status: "broken" })),
    /Invalid storage status filter/
  );

  assert.throws(
    () => buildDriveFileSearchWhere(normalizeDriveFileSearchFilters({ available: "maybe" })),
    /Invalid availability filter/
  );
});
