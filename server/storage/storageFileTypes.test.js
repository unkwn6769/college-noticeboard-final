import assert from "node:assert/strict";
import test from "node:test";
import { aggregateFileTypes, classifyFileType } from "./storageFileTypesMath.js";

test("classifies common file types into stable groups", () => {
  assert.equal(classifyFileType("report.pdf").key, "pdf");
  assert.equal(classifyFileType("lecture.docx").key, "documents");
  assert.equal(classifyFileType("marks.xlsx").key, "spreadsheets");
  assert.equal(classifyFileType("photo.JPG").key, "images");
  assert.equal(classifyFileType("clip.mp4").key, "video");
  assert.equal(classifyFileType("bundle.zip").key, "archives");
  assert.equal(classifyFileType("README").key, "unknown");
  assert.equal(classifyFileType("data.custom").key, "other");
});

test("aggregates file sizes with BigInt-safe totals and unknown-size counts", () => {
  const summary = aggregateFileTypes([
    { name: "a.pdf", sizeBytes: "1073741824" },
    { name: "b.pdf", sizeBytes: "2147483648" },
    { name: "c.jpg", sizeBytes: "536870912" },
    { name: "d.docx", sizeBytes: null },
  ]);

  assert.equal(summary.totalFiles, 4);
  assert.equal(summary.knownSizeFiles, 3);
  assert.equal(summary.unknownSizeFiles, 1);
  assert.equal(summary.totalBytes, "3758096384");
  assert.deepEqual(summary.groups[0], {
    key: "pdf",
    label: "PDF",
    fileCount: 2,
    sizeBytes: "3221225472",
    unknownSizeCount: 0,
    extensions: ["pdf"],
    percent: 85.71,
  });
});
