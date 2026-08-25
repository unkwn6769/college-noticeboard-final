import { getGoogleDriveClient } from "./googleClient.js";

export async function getGoogleDriveFile(resource) {
  if (!resource.storage_key) {
    throw new Error("Google Drive resource has no storage_key");
  }

  const drive = await getGoogleDriveClient(resource.storage_key);

  const metadata = await drive.files.get({
    fileId: resource.storage_key,
    fields: "id,name,size,mimeType",
  });

  return {
    type: "google_drive",
    drive,
    metadata: metadata.data,
  };
}