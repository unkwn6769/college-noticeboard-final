const DOWNLOAD_BYTES = 10_000_000;
const UPLOAD_BYTES = 5_000_000;
const TIMEOUT_MS = 20_000;

function mbps(bytes, milliseconds) {
  if (!milliseconds) return 0;

  return Number(
    ((bytes * 8) / (milliseconds / 1000) / 1_000_000).toFixed(2)
  );
}

async function timedDownload() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = process.hrtime.bigint();

  try {
    const response = await fetch(
      `https://speed.cloudflare.com/__down?bytes=${DOWNLOAD_BYTES}`,
      {
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      throw new Error(`Download HTTP ${response.status}`);
    }

    const body = await response.arrayBuffer();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    return {
      bytes: body.byteLength,
      elapsedMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function timedUpload() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const payload = Buffer.alloc(UPLOAD_BYTES);
  const started = process.hrtime.bigint();

  try {
    const response = await fetch(
      "https://speed.cloudflare.com/__up",
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(payload.length),
        },
        body: payload,
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      throw new Error(`Upload HTTP ${response.status}`);
    }

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    return {
      bytes: payload.length,
      elapsedMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function timedLatency() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = process.hrtime.bigint();

  try {
    const response = await fetch(
      "https://speed.cloudflare.com/__down?bytes=1",
      {
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      throw new Error(`Latency HTTP ${response.status}`);
    }

    await response.arrayBuffer();

    return Number(
      (Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function runNetworkDiagnostic() {
  const [download, upload, latencyMs] = await Promise.all([
    timedDownload(),
    timedUpload(),
    timedLatency(),
  ]);

  return {
    testedAt: new Date().toISOString(),

    download: {
      bytes: download.bytes,
      elapsedMs: Number(download.elapsedMs.toFixed(1)),
      mbps: mbps(download.bytes, download.elapsedMs),
      MBps: Number(
        (download.bytes / download.elapsedMs / 1000).toFixed(2)
      ),
    },

    upload: {
      bytes: upload.bytes,
      elapsedMs: Number(upload.elapsedMs.toFixed(1)),
      mbps: mbps(upload.bytes, upload.elapsedMs),
      MBps: Number(
        (upload.bytes / upload.elapsedMs / 1000).toFixed(2)
      ),
    },

    latencyMs,
  };
}
