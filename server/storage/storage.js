import { getCollegeFile } from "./college.js";
import { getGoogleDriveFile } from "./googleDrive.js";

export async function getFileStream(resource) {
  switch (resource.storage_provider) {
    case "college":
      return getCollegeFile(resource);

    case "google_drive":
      return getGoogleDriveFile(resource);

    default:
      throw new Error(
        `Unknown storage provider: ${resource.storage_provider}`
      );
  }
}