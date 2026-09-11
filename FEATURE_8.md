# Feature 8 — Drive File Search / Filter

## Implemented

- Added `/admin/file-search` for searching the managed Google Drive inventory.
- Search covers filename, stored path, and Drive file ID.
- Filters include Drive account, file type, storage status, and availability.
- Results are server-side paginated; the browser never loads the full file inventory.
- Added a Search files link from each account's file browser.
- Added a Drive File Search card to `/admin`.
- Existing public-page links remain available for matching noticeboard files.

## API

`GET /api/admin/drive-files`

Query parameters:

- `q`
- `accountId`
- `fileType`
- `status`
- `available`
- `page`
- `pageSize`

## File-type filters

PDF, documents, spreadsheets, presentations, images, video, audio, archives, code, text, other/unknown, and no-extension files are supported.

## Safety / scale behavior

Search and filtering are performed in PostgreSQL against the managed file inventory. Results are paginated and ordered deterministically by normalized filename, resource id, and Drive file id.

No Google Drive files are modified by Feature 8.
