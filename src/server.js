import http from "node:http";
import path from "node:path";
import express from "express";
import { Server } from "socket.io";
import { config } from "./config.js";
import { kafkaClient, producerOptions } from "./kafka-client.js";
import {
  consumeAuthorizationCode,
  createAuthorizationCode,
  createUser,
  findUserById,
  upsertOAuthUser,
  verifyUser,
} from "./auth-store.js";
import {
  consumeGoogleState,
  createGoogleAuthorizationUrl,
  exchangeGoogleCodeForProfile,
} from "./google-oauth.js";
import {
  getDiscoveryDocument,
  getJwks,
  signTokens,
  verifyPkce,
  verifyToken,
} from "./oidc.js";
import {
  isDuplicateEvent,
  normalizeLocationEvent,
} from "./location-events.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: config.publicBaseUrl,
    credentials: true,
  },
});

const activeUsers = new Map();

app.use(express.json());
app.use(express.static(path.resolve("public")));

function requireOAuthFields(body) {
  const required = ["client_id", "redirect_uri", "state", "code_challenge"];
  for (const field of required) {
    if (!body[field]) {
      const error = new Error(`Missing OAuth field: ${field}`);
      error.statusCode = 400;
      throw error;
    }
  }

  if (body.client_id !== config.oidc.clientId) {
    const error = new Error("Unknown OAuth client_id.");
    error.statusCode = 400;
    throw error;
  }

  if (body.redirect_uri !== config.oidc.redirectUri) {
    const error = new Error("Invalid redirect_uri.");
    error.statusCode = 400;
    throw error;
  }
}

function makeRedirectUrl({ redirectUri, code, state }) {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return url.toString();
}

function createLoginRedirect({ user, body }) {
  requireOAuthFields(body);
  const code = createAuthorizationCode({
    user,
    clientId: body.client_id,
    redirectUri: body.redirect_uri,
    codeChallenge: body.code_challenge,
    codeChallengeMethod: body.code_challenge_method ?? "S256",
  });

  return makeRedirectUrl({
    redirectUri: body.redirect_uri,
    code,
    state: body.state,
  });
}

function updateActiveUser(event) {
  const current = activeUsers.get(event.userId) ?? {
    userId: event.userId,
    userName: event.userName,
    sockets: new Set(),
  };

  current.userName = event.userName;
  current.lastLocation = {
    latitude: event.latitude,
    longitude: event.longitude,
    accuracy: event.accuracy,
    updatedAt: event.serverReceivedAt,
  };
  current.lastSeenAt = Date.now();
  activeUsers.set(event.userId, current);
  return current;
}

function publicActiveUsers() {
  return Array.from(activeUsers.values()).map((user) => ({
    userId: user.userId,
    userName: user.userName,
    lastLocation: user.lastLocation ?? null,
    lastSeenAt: user.lastSeenAt ?? null,
  }));
}

app.get("/health", (_req, res) => {
  res.json({ healthy: true, kafkaTopic: config.kafka.topic });
});

app.get("/config", (_req, res) => {
  res.json({
    oidcClientId: config.oidc.clientId,
    oidcRedirectUri: config.oidc.redirectUri,
    googleOAuthEnabled: Boolean(
      config.google.clientId && config.google.clientSecret,
    ),
    locationUpdateIntervalMs: config.location.updateIntervalMs,
    staleUserAfterMs: config.location.staleUserAfterMs,
  });
});

app.get("/.well-known/openid-configuration", (_req, res) => {
  res.json(getDiscoveryDocument());
});

app.get("/.well-known/jwks.json", (_req, res) => {
  res.json(getJwks());
});

app.get("/oauth/authorize", (req, res) => {
  const params = new URLSearchParams(req.query).toString();
  res.redirect(`/?${params}`);
});

app.post("/auth/sign-up", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      res.status(400).json({ message: "Name, email, and password are required." });
      return;
    }

    const user = await createUser({ name, email, password });
    res.status(201).json({
      redirectTo: createLoginRedirect({ user, body: req.body }),
    });
  } catch (error) {
    res.status(error.statusCode ?? 500).json({ message: error.message });
  }
});

app.post("/auth/sign-in", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ message: "Email and password are required." });
      return;
    }

    const user = await verifyUser({ email, password });
    res.json({
      redirectTo: createLoginRedirect({ user, body: req.body }),
    });
  } catch (error) {
    res.status(error.statusCode ?? 500).json({ message: error.message });
  }
});

app.get("/auth/google/start", (req, res) => {
  try {
    requireOAuthFields(req.query);
    const redirectTo = createGoogleAuthorizationUrl({
      clientId: req.query.client_id,
      redirectUri: req.query.redirect_uri,
      state: req.query.state,
      codeChallenge: req.query.code_challenge,
      codeChallengeMethod: req.query.code_challenge_method ?? "S256",
    });

    res.redirect(redirectTo);
  } catch (error) {
    res.status(error.statusCode ?? 500).send(error.message);
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) {
      res.status(400).send(error_description || error);
      return;
    }

    if (!code || !state) {
      res.status(400).send("Google callback requires code and state.");
      return;
    }

    const localOAuth = consumeGoogleState(state);
    const googleProfile = await exchangeGoogleCodeForProfile({
      code,
      googleVerifier: localOAuth.googleVerifier,
    });
    const user = await upsertOAuthUser({
      provider: "google",
      providerSub: googleProfile.providerSub,
      email: googleProfile.email,
      name: googleProfile.name,
    });

    const localCode = createAuthorizationCode({
      user,
      clientId: localOAuth.clientId,
      redirectUri: localOAuth.redirectUri,
      codeChallenge: localOAuth.codeChallenge,
      codeChallengeMethod: localOAuth.codeChallengeMethod,
    });

    res.redirect(
      makeRedirectUrl({
        redirectUri: localOAuth.redirectUri,
        code: localCode,
        state: localOAuth.state,
      }),
    );
  } catch (error) {
    res.status(error.statusCode ?? 500).send(error.message);
  }
});

app.post("/oauth/token", async (req, res) => {
  try {
    const { code, client_id, redirect_uri, code_verifier } = req.body;
    if (!code || !client_id || !redirect_uri) {
      res.status(400).json({ message: "code, client_id, and redirect_uri are required." });
      return;
    }

    const record = consumeAuthorizationCode(code);
    if (record.clientId !== client_id || record.redirectUri !== redirect_uri) {
      res.status(400).json({ message: "Authorization code was issued to a different client." });
      return;
    }

    const pkceOk = verifyPkce({
      verifier: code_verifier,
      challenge: record.codeChallenge,
      method: record.codeChallengeMethod,
    });

    if (!pkceOk) {
      res.status(400).json({ message: "PKCE verification failed." });
      return;
    }

    res.json(signTokens(record.user));
  } catch (error) {
    res.status(error.statusCode ?? 500).json({ message: error.message });
  }
});

app.get("/oauth/userinfo", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ message: "Missing bearer token." });
      return;
    }

    const claims = verifyToken(authHeader.slice(7));
    const user = await findUserById(claims.sub);
    if (!user) {
      res.status(404).json({ message: "User not found." });
      return;
    }

    res.json({
      sub: user.id,
      email: user.email,
      email_verified: true,
      name: user.name,
    });
  } catch {
    res.status(401).json({ message: "Invalid or expired token." });
  }
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      next(new Error("Authentication token is required."));
      return;
    }

    socket.user = verifyToken(token);
    next();
  } catch {
    next(new Error("Invalid or expired authentication token."));
  }
});

async function main() {
  const producer = kafkaClient.producer(producerOptions);
  const consumer = kafkaClient.consumer({
    groupId: `socket-broadcaster-${config.port}`,
  });

  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({
    topic: config.kafka.topic,
    fromBeginning: false,
  });

  await consumer.run({
    eachMessage: async ({ message, heartbeat }) => {
      const event = JSON.parse(message.value.toString());
      updateActiveUser(event);
      io.emit("server:location:update", {
        eventId: event.eventId,
        userId: event.userId,
        userName: event.userName,
        latitude: event.latitude,
        longitude: event.longitude,
        accuracy: event.accuracy,
        updatedAt: event.serverReceivedAt,
      });
      await heartbeat();
    },
  });

  io.on("connection", (socket) => {
    const userId = socket.user.sub;
    const userName = socket.user.name || socket.user.email;
    const record = activeUsers.get(userId) ?? {
      userId,
      userName,
      sockets: new Set(),
      lastSeenAt: Date.now(),
    };

    record.sockets.add(socket.id);
    record.userName = userName;
    record.lastSeenAt = Date.now();
    activeUsers.set(userId, record);

    socket.emit("server:active-users", publicActiveUsers());
    socket.broadcast.emit("server:user:online", { userId, userName });
    console.log(`[socket] ${userName} connected as ${userId}`);

    socket.on("client:location:update", async (payload, ack) => {
      try {
        const event = normalizeLocationEvent({
          payload,
          user: socket.user,
          socketId: socket.id,
        });

        if (isDuplicateEvent(event)) {
          ack?.({ ok: true, duplicate: true });
          return;
        }

        await producer.send({
          topic: config.kafka.topic,
          messages: [
            {
              key: event.userId,
              value: JSON.stringify(event),
              headers: {
                eventId: event.eventId,
                userId: event.userId,
              },
            },
          ],
        });

        ack?.({ ok: true, eventId: event.eventId });
      } catch (error) {
        socket.emit("server:location:error", { message: error.message });
        ack?.({ ok: false, message: error.message });
      }
    });

    socket.on("disconnect", (reason) => {
      const current = activeUsers.get(userId);
      if (!current) return;

      current.sockets.delete(socket.id);
      current.lastSeenAt = Date.now();

      if (current.sockets.size === 0) {
        io.emit("server:user:offline", { userId, reason });
      }

      console.log(`[socket] ${userName} disconnected: ${reason}`);
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [userId, user] of activeUsers) {
      const hasOpenSockets = user.sockets?.size > 0;
      const isStale = now - (user.lastSeenAt ?? 0) > config.location.staleUserAfterMs;
      if (!hasOpenSockets && isStale) {
        activeUsers.delete(userId);
        io.emit("server:user:stale", { userId });
      }
    }
  }, 5000);

  app.get(["/", "/callback"], (_req, res) => {
    res.sendFile(path.resolve("public", "index.html"));
  });

  server.listen(config.port, () => {
    console.log(`Live Location Tracker running at ${config.publicBaseUrl}`);
    console.log(`Kafka topic: ${config.kafka.topic}`);
  });
}

main().catch((error) => {
  console.error("Server failed to start", error);
  process.exitCode = 1;
});
