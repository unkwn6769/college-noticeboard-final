const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize),
    );
  }

  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

/*
 * Compatible with the existing Node implementation:
 *
 * key = SHA-256(TOKEN_ENCRYPTION_KEY)
 * cipher = AES-256-GCM
 * IV = 12 random bytes
 * stored format = base64(iv):base64(tag):base64(ciphertext)
 */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(secret),
  );

  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptText(
  value: string,
  secret: string,
): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  /*
   * Web Crypto returns ciphertext || 16-byte authentication tag.
   * The existing Node implementation stores them separately.
   */
  const combined = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: 128,
      },
      key,
      encoder.encode(value),
    ),
  );

  const tag = combined.slice(-16);
  const ciphertext = combined.slice(0, -16);

  return [
    toBase64(iv),
    toBase64(tag),
    toBase64(ciphertext),
  ].join(":");
}

export async function decryptText(
  value: string,
  secret: string,
): Promise<string> {
  const [ivRaw, tagRaw, encryptedRaw] = String(value).split(":");

  if (!ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Invalid encrypted token");
  }

  const iv = fromBase64(ivRaw);
  const tag = fromBase64(tagRaw);
  const ciphertext = fromBase64(encryptedRaw);

  const combined = new Uint8Array(
    ciphertext.length + tag.length,
  );

  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);

  const key = await deriveKey(secret);

  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      tagLength: 128,
    },
    key,
    combined,
  );

  return decoder.decode(plaintext);
}
