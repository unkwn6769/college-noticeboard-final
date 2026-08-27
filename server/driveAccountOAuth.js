import crypto from "node:crypto";
import { google } from "googleapis";
import { pool } from "./db/database.js";

function getDriveOAuthClient() {
  if (
    !process.env.DRIVE_ACCOUNT_GOOGLE_CLIENT_ID ||
    !process.env.DRIVE_ACCOUNT_GOOGLE_CLIENT_SECRET ||
    !process.env.DRIVE_ACCOUNT_GOOGLE_REDIRECT_URI
  ) {
    throw new Error(
      "Drive account Google OAuth environment is not configured"
    );
  }

  return new google.auth.OAuth2(
    process.env.DRIVE_ACCOUNT_GOOGLE_CLIENT_ID,
    process.env.DRIVE_ACCOUNT_GOOGLE_CLIENT_SECRET,
    process.env.DRIVE_ACCOUNT_GOOGLE_REDIRECT_URI
  );
}

function createState(sessionId) {
  const payload = {
    nonce: crypto.randomBytes(24).toString("hex"),
    sessionHash: crypto
      .createHash("sha256")
      .update(sessionId)
      .digest("hex"),
    exp: Date.now() + 10 * 60 * 1000,
  };

  const raw = Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url");

  const signature = crypto
    .createHmac(
      "sha256",
      process.env.ADMIN_SESSION_SECRET
    )
    .update(raw)
    .digest("base64url");

  return `${raw}.${signature}`;
}

function verifyState(state, sessionId) {
  const [raw, signature] =
    String(state || "").split(".");

  if (!raw || !signature) {
    throw new Error("Invalid Drive OAuth state");
  }

  const expected = crypto
    .createHmac(
      "sha256",
      process.env.ADMIN_SESSION_SECRET
    )
    .update(raw)
    .digest("base64url");

  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(
      actualBuffer,
      expectedBuffer
    )
  ) {
    throw new Error(
      "Invalid Drive OAuth state signature"
    );
  }

  const payload = JSON.parse(
    Buffer.from(raw, "base64url").toString("utf8")
  );

  if (!payload.exp || payload.exp < Date.now()) {
    throw new Error("Drive OAuth state expired");
  }

  const expectedSessionHash = crypto
    .createHash("sha256")
    .update(sessionId)
    .digest("hex");

  if (
    payload.sessionHash !== expectedSessionHash
  ) {
    throw new Error(
      "Drive OAuth state does not belong to this admin session"
    );
  }

  return payload;
}

function encryptText(value) {
  const key = crypto
    .createHash("sha256")
    .update(process.env.TOKEN_ENCRYPTION_KEY)
    .digest();

  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function getDriveAccountAuthorizationUrl(
  sessionId
) {
  const oauth = getDriveOAuthClient();

  return oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: true,
    scope: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/drive",
    ],
    state: createState(sessionId),
  });
}

export async function handleDriveAccountCallback(
  code,
  state,
  sessionId
) {
  verifyState(state, sessionId);

  if (!code) {
    throw new Error(
      "Missing Google Drive authorization code"
    );
  }

  const oauth = getDriveOAuthClient();

  const { tokens } = await oauth.getToken(code);

  oauth.setCredentials(tokens);

  const oauth2 = google.oauth2({
    auth: oauth,
    version: "v2",
  });

  const userInfo = await oauth2.userinfo.get();

  const email = String(
    userInfo.data.email || ""
  )
    .trim()
    .toLowerCase();

  if (!email) {
    throw new Error(
      "Google did not return an email address"
    );
  }

  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;

  if (!accessToken || !refreshToken) {
    throw new Error(
      "Google did not return the required Drive tokens"
    );
  }

  const clientId =
    process.env.DRIVE_ACCOUNT_GOOGLE_CLIENT_ID;

  const clientSecret =
    process.env.DRIVE_ACCOUNT_GOOGLE_CLIENT_SECRET;

  const redirectUri =
    process.env.DRIVE_ACCOUNT_GOOGLE_REDIRECT_URI;

  const accountId = crypto.randomUUID();

  const existing = await pool.query(
    `
    SELECT id
    FROM google_drive_accounts
    WHERE LOWER(email) = $1
    LIMIT 1
    `,
    [email]
  );

  const encryptedClientId = encryptText(clientId);
  const encryptedClientSecret =
    encryptText(clientSecret);
  const encryptedAccessToken =
    encryptText(accessToken);
  const encryptedRefreshToken =
    encryptText(refreshToken);

  const expiryDate = tokens.expiry_date
    ? new Date(tokens.expiry_date)
    : null;

  if (existing.rows.length > 0) {
    await pool.query(
      `
      UPDATE google_drive_accounts
      SET
        client_id_encrypted = $1,
        client_secret_encrypted = $2,
        access_token_encrypted = $3,
        refresh_token_encrypted = $4,
        token_expires_at = $5,
        redirect_uri = $6,
        status = 'connected',
        updated_at = NOW()
      WHERE id = $7
      `,
      [
        encryptedClientId,
        encryptedClientSecret,
        encryptedAccessToken,
        encryptedRefreshToken,
        expiryDate,
        redirectUri,
        existing.rows[0].id,
      ]
    );

    return {
      accountId: existing.rows[0].id,
      email,
      replaced: true,
    };
  }

  await pool.query(
    `
    INSERT INTO google_drive_accounts (
      id,
      email,
      provider_account_id,
      client_id_encrypted,
      client_secret_encrypted,
      access_token_encrypted,
      refresh_token_encrypted,
      token_expires_at,
      redirect_uri,
      status
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,'connected'
    )
    `,
    [
      accountId,
      email,
      userInfo.data.id || email,
      encryptedClientId,
      encryptedClientSecret,
      encryptedAccessToken,
      encryptedRefreshToken,
      expiryDate,
      redirectUri,
    ]
  );

  return {
    accountId,
    email,
    replaced: false,
  };
}
