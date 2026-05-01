import crypto from "node:crypto";
import { config } from "./config.js";
import { createCodeChallenge } from "./oidc.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

function isGoogleConfigured() {
  return Boolean(
    config.google.clientId &&
      config.google.clientSecret &&
      config.google.stateSigningSecret,
  );
}

function encodeState(localOAuth) {
  const payload = {
    ...localOAuth,
    googleVerifier: crypto.randomBytes(32).toString("base64url"),
    exp: Date.now() + 10 * 60 * 1000,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", config.google.stateSigningSecret)
    .update(payloadB64)
    .digest("base64url");
  return {
    state: `${payloadB64}.${signature}`,
    googleVerifier: payload.googleVerifier,
  };
}

function decodeState(state) {
  const [payloadB64, signature] = String(state).split(".");
  if (!payloadB64 || !signature) {
    const error = new Error("Invalid or expired Google OAuth state.");
    error.statusCode = 400;
    throw error;
  }

  const expected = crypto
    .createHmac("sha256", config.google.stateSigningSecret)
    .update(payloadB64)
    .digest("base64url");

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    const error = new Error("Invalid or expired Google OAuth state.");
    error.statusCode = 400;
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    const error = new Error("Invalid or expired Google OAuth state.");
    error.statusCode = 400;
    throw error;
  }

  if (!payload.exp || payload.exp < Date.now()) {
    const error = new Error("Invalid or expired Google OAuth state.");
    error.statusCode = 400;
    throw error;
  }

  return payload;
}

export function createGoogleAuthorizationUrl(localOAuth) {
  if (!isGoogleConfigured()) {
    const error = new Error(
      "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_STATE_SIGNING_SECRET.",
    );
    error.statusCode = 501;
    throw error;
  }

  const { state: googleState, googleVerifier } = encodeState(localOAuth);

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.google.clientId);
  url.searchParams.set("redirect_uri", config.google.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", googleState);
  url.searchParams.set("code_challenge", createCodeChallenge(googleVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");

  return url.toString();
}

export function consumeGoogleState(state) {
  return decodeState(state);
}

export async function exchangeGoogleCodeForProfile({ code, googleVerifier }) {
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: "authorization_code",
      code_verifier: googleVerifier,
    }),
  });

  const tokens = await tokenResponse.json();
  if (!tokenResponse.ok) {
    const error = new Error(tokens.error_description || "Google token exchange failed.");
    error.statusCode = 502;
    throw error;
  }

  const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  const profile = await userInfoResponse.json();
  if (!userInfoResponse.ok) {
    const error = new Error(profile.error_description || "Google userinfo lookup failed.");
    error.statusCode = 502;
    throw error;
  }

  if (!profile.sub || !profile.email) {
    const error = new Error("Google profile did not include sub and email.");
    error.statusCode = 502;
    throw error;
  }

  if (profile.email_verified === false) {
    const error = new Error("Google email must be verified.");
    error.statusCode = 403;
    throw error;
  }

  return {
    providerSub: profile.sub,
    email: profile.email,
    name: profile.name || profile.email,
  };
}
