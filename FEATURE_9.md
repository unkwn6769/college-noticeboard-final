# Feature 9 — Live Google Drive Breadcrumbs

Drive account browsing now reads the selected folder directly from the connected Google Drive API.

- Root view scans the actual Drive root.
- Folder buttons use real Google Drive folder IDs.
- Clicking a folder performs a live Drive `files.list` query for that folder's direct children.
- Nested folders work without depending on the College Noticeboard `resources` table.
- Breadcrumbs preserve real folder IDs and names and allow direct navigation back to any parent.
- Parent folder navigation uses the Drive API's actual parent relationship.
- Files show real Drive metadata (name, MIME type, size, modified time, and Drive link).
- Managed files are additionally annotated with College Noticeboard resource metadata when a matching `storage_key` exists.
- Pagination uses Google Drive page tokens rather than pretending the Drive API has a database-style total count.
- The previous application-mapped inventory endpoint remains available for search/inventory use; Feature 9's browser is now explicitly a live Drive scan.
