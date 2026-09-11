# Feature 7 — Admin ↔ Public Page Links

Implemented public/admin navigation links.

## Admin → Public
- Admin dashboard links to the public website.
- Admin Drive file browser exposes a Public page link for noticeboard-managed files.
- The public page opens in a new tab.

## Public → Admin
- Public department pages include an Admin link.
- Public file pages include an Admin link.
- The existing admin authentication gate remains responsible for access; unauthenticated users are redirected to `/admin/login`.

No backend or database changes are required for this feature.
