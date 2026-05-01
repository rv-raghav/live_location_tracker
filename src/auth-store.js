import crypto from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { db } from "./db.js";
import { authorizationCodes, users } from "./schema.js";

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    provider: user.provider ?? "local",
    createdAt: new Date(user.createdAt).toISOString(),
  };
}

export async function createUser({ name, email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await db.query.users.findFirst({
    where: eq(users.email, normalizedEmail),
  });

  if (existing) {
    const error = new Error("An account already exists for this email.");
    error.statusCode = 409;
    throw error;
  }

  const { salt, hash } = hashPassword(password);
  const id = crypto.randomUUID();

  await db.insert(users).values({
    id,
    name: name.trim(),
    email: normalizedEmail,
    provider: "local",
    passwordHash: hash,
    salt,
  });

  const created = await db.query.users.findFirst({ where: eq(users.id, id) });
  return publicUser(created);
}

export async function verifyUser({ email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await db.query.users.findFirst({
    where: eq(users.email, normalizedEmail),
  });

  if (!user) {
    const error = new Error("Invalid email or password.");
    error.statusCode = 401;
    throw error;
  }

  if (!user.passwordHash || !user.salt) {
    const error = new Error("Use Google sign in for this account.");
    error.statusCode = 401;
    throw error;
  }

  const { hash } = hashPassword(password, user.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.passwordHash))) {
    const error = new Error("Invalid email or password.");
    error.statusCode = 401;
    throw error;
  }

  return publicUser(user);
}

export async function upsertOAuthUser({ provider, providerSub, email, name }) {
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await db.query.users.findFirst({
    where: or(
      and(eq(users.provider, provider), eq(users.providerSub, providerSub)),
      eq(users.email, normalizedEmail),
    ),
  });

  if (existing) {
    await db
      .update(users)
      .set({
        provider: existing.provider ?? provider,
        providerSub: existing.providerSub ?? providerSub,
        name: name?.trim() || existing.name,
        email: normalizedEmail,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id));

    const updated = await db.query.users.findFirst({
      where: eq(users.id, existing.id),
    });
    return publicUser(updated);
  }

  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    name: name?.trim() || normalizedEmail,
    email: normalizedEmail,
    provider,
    providerSub,
  });

  const created = await db.query.users.findFirst({ where: eq(users.id, id) });
  return publicUser(created);
}

export async function findUserById(id) {
  const user = await db.query.users.findFirst({ where: eq(users.id, id) });
  return user ? publicUser(user) : null;
}

export async function createAuthorizationCode(payload) {
  const code = crypto.randomBytes(32).toString("base64url");
  await db.insert(authorizationCodes).values({
    code,
    userId: payload.user.id,
    userName: payload.user.name,
    userEmail: payload.user.email,
    userProvider: payload.user.provider ?? "local",
    clientId: payload.clientId,
    redirectUri: payload.redirectUri,
    state: payload.state,
    codeChallenge: payload.codeChallenge ?? null,
    codeChallengeMethod: payload.codeChallengeMethod ?? null,
    expiresAt: new Date(Date.now() + 2 * 60 * 1000),
  });
  return code;
}

export async function consumeAuthorizationCode(code) {
  const record = await db.query.authorizationCodes.findFirst({
    where: eq(authorizationCodes.code, code),
  });

  await db.delete(authorizationCodes).where(eq(authorizationCodes.code, code));

  if (!record || record.expiresAt.getTime() < Date.now()) {
    const error = new Error("Invalid or expired authorization code.");
    error.statusCode = 400;
    throw error;
  }

  return {
    user: {
      id: record.userId,
      name: record.userName,
      email: record.userEmail,
      provider: record.userProvider,
      createdAt: new Date().toISOString(),
    },
    clientId: record.clientId,
    redirectUri: record.redirectUri,
    state: record.state,
    codeChallenge: record.codeChallenge,
    codeChallengeMethod: record.codeChallengeMethod,
  };
}
