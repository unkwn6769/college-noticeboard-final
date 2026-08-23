const NINE_DRIVE_URL =
  process.env.NINE_DRIVE_URL || "http://localhost:4000";

const NINE_DRIVE_API_KEY =
  process.env.NINE_DRIVE_API_KEY;

if (!NINE_DRIVE_API_KEY) {
  throw new Error("NINE_DRIVE_API_KEY is missing");
}

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

export async function uploadBufferTo9Drive(
  resource,
  buffer
) {
  const mimeType = getMimeType(resource.name);

  const form = new FormData();

  form.append(
    "filesMeta",
    JSON.stringify([
      {
        fieldName: "file-0",
        fileName: resource.name,
        mimeType,
        sizeBytes: String(buffer.length),
      },
    ])
  );

  form.append(
    "file-0",
    new Blob([buffer], {
      type: mimeType,
    }),
    resource.name
  );

  console.log(
    `[${resource.id}] Uploading ${buffer.length} bytes`
  );

  const uploadResponse = await fetch(
    `${NINE_DRIVE_URL}/api/v1/uploads`,
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${NINE_DRIVE_API_KEY}`,
      },
      body: form,
    }
  );

  const text = await uploadResponse.text();

  if (!uploadResponse.ok) {
    throw new Error(
      `9Drive ${uploadResponse.status}: ${text}`
    );
  }

  const data = JSON.parse(text);
  const uploaded = data.files?.[0];

  if (!uploaded?.id) {
    throw new Error(
      `9Drive did not return a file ID: ${text}`
    );
  }

  return uploaded.id;
}