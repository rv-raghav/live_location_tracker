import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

export function createCodeChallenge(verifier) {
  return toBase64Url(crypto.createHash("sha256").update(verifier).digest());
}

export function verifyPkce({ verifier, challenge, method }) {
  if (!challenge) return true;
  if (!verifier) return false;
  if (method && method !== "S256") return false;
  return createCodeChallenge(verifier) === challenge;
}

export function getDiscoveryDocument() {
  return {
    issuer: config.oidc.issuer,
    authorization_endpoint: `${config.publicBaseUrl}/oauth/authorize`,
    token_endpoint: `${config.publicBaseUrl}/oauth/token`,
    userinfo_endpoint: `${config.publicBaseUrl}/oauth/userinfo`,
    jwks_uri: `${config.publicBaseUrl}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "profile", "email"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
}

export function getJwks() {
  const jwk = publicKey.export({ format: "jwk" });
  return {
    keys: [
      {
        ...jwk,
        kid: "live-location-dev-key",
        alg: "RS256",
        use: "sig",
      },
    ],
  };
}

export function signTokens(user) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: config.oidc.issuer,
    aud: config.oidc.clientId,
    sub: user.id,
    email: user.email,
    email_verified: true,
    name: user.name,
    iat: now,
    exp: now + config.oidc.tokenTtlSeconds,
  };

  const token = jwt.sign(claims, privateKey, {
    algorithm: "RS256",
    keyid: "live-location-dev-key",
  });

  return {
    access_token: token,
    id_token: token,
    token_type: "Bearer",
    expires_in: config.oidc.tokenTtlSeconds,
  };
}

export function verifyToken(token) {
  return jwt.verify(token, publicKey, {
    algorithms: ["RS256"],
    issuer: config.oidc.issuer,
    audience: config.oidc.clientId,
  });
}
