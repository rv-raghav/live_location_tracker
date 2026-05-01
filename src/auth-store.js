import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const usersFile = path.resolve("./data/users.json");
const authorizationCodes = new Map();

async function readUsers() {
  try {
    const raw = await fs.readFile(usersFile, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeUsers(users) {
  await fs.mkdir(path.dirname(usersFile), { recursive: true });
  await fs.writeFile(usersFile, JSON.stringify(users, null, 2));
}

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
    createdAt: user.createdAt,
  };
}

export async function createUser({ name, email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  const users = await readUsers();
  const existing = users.find((user) => user.email === normalizedEmail);
  if (existing) {
    const error = new Error("An account already exists for this email.");
    error.statusCode = 409;
    throw error;
  }

  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    name: name.trim(),
    email: normalizedEmail,
    provider: "local",
    passwordHash: hash,
    salt,
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  await writeUsers(users);
  return publicUser(user);
}

export async function verifyUser({ email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  const users = await readUsers();
  const user = users.find((candidate) => candidate.email === normalizedEmail);

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
  const users = await readUsers();
  const existing = users.find(
    (user) =>
      (user.provider === provider && user.providerSub === providerSub) ||
      user.email === normalizedEmail,
  );

  if (existing) {
    existing.provider = existing.provider ?? provider;
    existing.providerSub = existing.providerSub ?? providerSub;
    existing.name = name?.trim() || existing.name;
    existing.email = normalizedEmail;
    existing.updatedAt = new Date().toISOString();
    await writeUsers(users);
    return publicUser(existing);
  }

  const user = {
    id: crypto.randomUUID(),
    name: name?.trim() || normalizedEmail,
    email: normalizedEmail,
    provider,
    providerSub,
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  await writeUsers(users);
  return publicUser(user);
}

export async function findUserById(id) {
  const users = await readUsers();
  const user = users.find((candidate) => candidate.id === id);
  return user ? publicUser(user) : null;
}

export function createAuthorizationCode(payload) {
  const code = crypto.randomBytes(32).toString("base64url");
  authorizationCodes.set(code, {
    ...payload,
    expiresAt: Date.now() + 2 * 60 * 1000,
  });
  return code;
}

export function consumeAuthorizationCode(code) {
  const record = authorizationCodes.get(code);
  authorizationCodes.delete(code);

  if (!record || record.expiresAt < Date.now()) {
    const error = new Error("Invalid or expired authorization code.");
    error.statusCode = 400;
    throw error;
  }

  return record;
}
