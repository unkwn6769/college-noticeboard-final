export async function getGoogleDriveFile(resource) {
  const baseUrl = process.env.NINE_DRIVE_URL;
  const apiKey = process.env.NINE_DRIVE_API_KEY;

  if (!baseUrl) {
    throw new Error("NINE_DRIVE_URL is not configured");
  }

  if (!apiKey) {
    throw new Error("NINE_DRIVE_API_KEY is not configured");
  }

  if (!resource.storage_key) {
    throw new Error("Google Drive resource has no storage_key");
  }

  const url =
    `${baseUrl.replace(/\/+$/, "")}` +
    `/api/v1/files/${encodeURIComponent(resource.storage_key)}/download`;

  return {
    type: "google_drive",
    url,
    apiKey,
  };
}
