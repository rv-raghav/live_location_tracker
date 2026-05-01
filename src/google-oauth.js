import crypto from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { config } from "./config.js";
import { createCodeChallenge } from "./oidc.js";
import { db } from "./db.js";
import { googleOAuthStates } from "./schema.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

function isGoogleConfigured() {
  return Boolean(config.google.clientId && config.google.clientSecret);
}

async function cleanupStates() {
  await db
    .delete(googleOAuthStates)
    .where(lt(googleOAuthStates.expiresAt, new Date()));
}

export async function createGoogleAuthorizationUrl(localOAuth) {
  if (!isGoogleConfigured()) {
    const error = new Error(
      "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
    );
    error.statusCode = 501;
    throw error;
  }

  await cleanupStates();

  const state = crypto.randomBytes(32).toString("base64url");
  const googleVerifier = crypto.randomBytes(32).toString("base64url");

  await db.insert(googleOAuthStates).values({
    state,
    clientId: localOAuth.clientId,
    redirectUri: localOAuth.redirectUri,
    oauthState: localOAuth.state,
    codeChallenge: localOAuth.codeChallenge ?? null,
    codeChallengeMethod: localOAuth.codeChallengeMethod ?? null,
    googleVerifier,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.google.clientId);
  url.searchParams.set("redirect_uri", config.google.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", createCodeChallenge(googleVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");

  return url.toString();
}

export async function consumeGoogleState(state) {
  await cleanupStates();

  const record = await db.query.googleOAuthStates.findFirst({
    where: eq(googleOAuthStates.state, state),
  });
  await db.delete(googleOAuthStates).where(eq(googleOAuthStates.state, state));

  if (!record || record.expiresAt.getTime() < Date.now()) {
    const error = new Error("Invalid or expired Google OAuth state.");
    error.statusCode = 400;
    throw error;
  }

  return {
    clientId: record.clientId,
    redirectUri: record.redirectUri,
    state: record.oauthState,
    codeChallenge: record.codeChallenge,
    codeChallengeMethod: record.codeChallengeMethod,
    googleVerifier: record.googleVerifier,
  };
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
