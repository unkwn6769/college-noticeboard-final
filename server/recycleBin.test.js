import assert from "node:assert/strict";
import test from "node:test";

function normalize(file) {
  return {
    name: file.name || "Untitled",
    sizeBytes: file.size == null ? null : String(file.size),
    trashed: file.trashed === true,
  };
}

test("recycle bin normalizes trashed Drive file metadata", () => {
  assert.deepEqual(
    normalize({ id: "1", name: "notes.pdf", size: "1024", trashed: true }),
    { name: "notes.pdf", sizeBytes: "1024", trashed: true }
  );
});

test("recycle bin preserves unknown size instead of coercing it to zero", () => {
  assert.deepEqual(
    normalize({ id: "2", name: "shared-folder-file", trashed: true }),
    { name: "shared-folder-file", sizeBytes: null, trashed: true }
  );
});
