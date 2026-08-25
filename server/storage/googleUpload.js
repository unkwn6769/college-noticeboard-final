import { Readable } from "node:stream";
import { pool } from "../db/database.js";
import {
  getConnectedGoogleDriveAccounts,
} from "./googleClient.js";

function getMimeType(name) {
  const ext = name.toLowerCase().split(".").pop();

  const types = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    zip: "application/zip",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
  };

  return types[ext] || "application/octet-stream";
}

async function getCandidateAccounts() {
  const connected = await getConnectedGoogleDriveAccounts();
  const candidates = [];

  for (const entry of connected) {
    const about = await entry.drive.about.get({
      fields: "storageQuota,user",
    });

    const quota = about.data.storageQuota;

    if (!quota?.limit || !quota?.usage) {
      continue;
    }

    const freeBytes =
      BigInt(quota.limit) - BigInt(quota.usage);

    candidates.push({
      ...entry,
      freeBytes,
    });
  }

  candidates.sort((a, b) =>
    a.freeBytes > b.freeBytes
      ? -1
      : a.freeBytes < b.freeBytes
        ? 1
        : 0
  );

  return candidates;
}

export async function uploadBufferToGoogleDrive(
  resource,
  buffer
) {
  const mimeType = getMimeType(resource.name);

  const candidates = await getCandidateAccounts();

  if (candidates.length === 0) {
    throw new Error(
      "No connected Google Drive accounts with usable storage quota"
    );
  }

  const requiredBytes = BigInt(buffer.length);

  for (const candidate of candidates) {
    if (candidate.freeBytes < requiredBytes) {
      continue;
    }

    try {
      console.log(
        `[${resource.id}] Uploading ${buffer.length} bytes to ${candidate.account.email}`
      );

      const uploaded = await candidate.drive.files.create({
        requestBody: {
          name: resource.name,
          mimeType,
        },
        media: {
          mimeType,
          body: Readable.from(buffer),
        },
        fields: "id",
      });

      const fileId = uploaded.data.id;

      if (!fileId) {
        throw new Error(
          "Google Drive did not return a file ID"
        );
      }

      await pool.query(
        `
        INSERT INTO google_drive_file_accounts (
          file_id,
          account_id
        )
        VALUES ($1, $2)
        ON CONFLICT (file_id)
        DO UPDATE SET account_id = EXCLUDED.account_id
        `,
        [
          fileId,
          candidate.account.connected_account_id,
        ]
      );

      console.log(
        `[${resource.id}] GOOGLE DRIVE SYNCED → ${fileId} (${candidate.account.email})`
      );

      return fileId;
    } catch (error) {
      console.error(
        `[${resource.id}] Upload failed on ${candidate.account.email}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  throw new Error(
    "All connected Google Drive accounts failed or lacked sufficient storage"
  );
}
