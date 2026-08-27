import crypto from "node:crypto";
import { google } from "googleapis";
import { pool } from "./db/database.js";

const SESSION_COOKIE = "admin_session";
const SESSION_DAYS = 7;

function getOAuthClient() {
  if (
    !process.env.ADMIN_GOOGLE_CLIENT_ID ||
    !process.env.ADMIN_GOOGLE_CLIENT_SECRET ||
    !process.env.ADMIN_GOOGLE_REDIRECT_URI
  ) {
    throw new Error("Admin Google OAuth environment is not configured");
  }

  return new google.auth.OAuth2(
    process.env.ADMIN_GOOGLE_CLIENT_ID,
    process.env.ADMIN_GOOGLE_CLIENT_SECRET,
    process.env.ADMIN_GOOGLE_REDIRECT_URI
  );
}

function createState() {
  const payload = {
    nonce: crypto.randomBytes(24).toString("hex"),
    exp: Date.now() + 10 * 60 * 1000,
  };

  const raw = Buffer.from(JSON.stringify(payload)).toString("base64url");

  const signature = crypto
    .createHmac(
      "sha256",
      process.env.ADMIN_SESSION_SECRET
    )
    .update(raw)
    .digest("base64url");

  return `${raw}.${signature}`;
}

function verifyState(state) {
  const [raw, signature] = String(state || "").split(".");

  if (!raw || !signature) {
    throw new Error("Invalid OAuth state");
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
    throw new Error("Invalid OAuth state signature");
  }

  const payload = JSON.parse(
    Buffer.from(raw, "base64url").toString("utf8")
  );

  if (!payload.exp || payload.exp < Date.now()) {
    throw new Error("OAuth state expired");
  }

  return payload;
}

export function getGoogleAuthorizationUrl() {
  const oauth = getOAuthClient();

  return oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "select_account",
    scope: [
      "openid",
      "email",
      "profile",
    ],
    state: createState(),
  });
}

export async function handleGoogleCallback(code, state) {
  verifyState(state);

  if (!code) {
    throw new Error("Missing Google authorization code");
  }

  const oauth = getOAuthClient();

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
    throw new Error("Google did not return an email address");
  }

  const adminResult = await pool.query(
    `
    SELECT id, email
    FROM admin_users
    WHERE LOWER(email) = $1
    LIMIT 1
    `,
    [email]
  );

  if (adminResult.rows.length === 0) {
    throw new Error("Google account is not an authorized admin");
  }

  const admin = adminResult.rows[0];

  const sessionId = crypto
    .randomBytes(32)
    .toString("hex");

  await pool.query(
    `
    INSERT INTO admin_sessions (
      id,
      admin_user_id,
      expires_at
    )
    VALUES (
      $1,
      $2,
      NOW() + INTERVAL '7 days'
    )
    `,
    [sessionId, admin.id]
  );

  return {
    sessionId,
    email: admin.email,
  };
}

export async function getAdminFromSession(
  sessionId
) {
  if (!sessionId) {
    return null;
  }

  const result = await pool.query(
    `
    SELECT
      u.id,
      u.email,
      s.id AS session_id,
      s.expires_at
    FROM admin_sessions s
    JOIN admin_users u
      ON u.id = s.admin_user_id
    WHERE s.id = $1
      AND s.expires_at > NOW()
    LIMIT 1
    `,
    [sessionId]
  );

  return result.rows[0] ?? null;
}

export async function deleteAdminSession(sessionId) {
  if (!sessionId) {
    return;
  }

  await pool.query(
    `
    DELETE FROM admin_sessions
    WHERE id = $1
    `,
    [sessionId]
  );
}

export function parseSessionCookie(req) {
  const header = req.headers.cookie || "";

  const match = header
    .split(";")
    .map((part) => part.trim())
    .find((part) =>
      part.startsWith(`${SESSION_COOKIE}=`)
    );

  return match
    ? decodeURIComponent(
      match.slice(`${SESSION_COOKIE}=`.length)
    )
    : null;
}

export function setSessionCookie(res, sessionId) {
  const isProduction =
    process.env.NODE_ENV === "production" ||
    process.env.RENDER === "true";

  const sameSite = isProduction
    ? "None"
    : "Lax";

  res.setHeader(
    "Set-Cookie",
    [
      `admin_session=${encodeURIComponent(sessionId)}`,
      "HttpOnly",
      "Path=/",
      `SameSite=${sameSite}`,
      ...(isProduction ? ["Secure"] : []),
      `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
    ].join("; ")
  );
}

export function clearSessionCookie(res) {
  const isProduction =
    process.env.NODE_ENV === "production" ||
    process.env.RENDER === "true";

  const sameSite = isProduction
    ? "None"
    : "Lax";

  res.setHeader(
    "Set-Cookie",
    [
      "admin_session=",
      "HttpOnly",
      "Path=/",
      `SameSite=${sameSite}`,
      ...(isProduction ? ["Secure"] : []),
      "Max-Age=0",
    ].join("; ")
  );
}

export async function requireAdmin(req, res, next) {
  try {
    const sessionId = parseSessionCookie(req);

    const admin = await getAdminFromSession(sessionId);

    if (!admin) {
      return res.status(401).json({
        error: "Admin authentication required",
      });
    }

    req.admin = admin;
    next();
  } catch (error) {
    console.error("Admin authentication failed:", error);

    res.status(500).json({
      error: "Failed to authenticate admin",
    });
  }
}