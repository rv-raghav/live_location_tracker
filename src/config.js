import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const numberFromEnv = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
};

const booleanFromEnv = (key, fallback = false) => {
  const value = process.env[key];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const normalizePemFromEnv = (key) => {
  const value = process.env[key];
  if (!value) return "";
  return value.replace(/\\n/g, "\n").trim();
};

function normalizeKafkaBroker(rawBroker) {
  const broker = rawBroker.trim();
  if (!broker) return "";

  // KafkaJS expects broker entries as host:port. If a scheme is provided
  // (e.g. https://host:443), strip it for compatibility.
  if (broker.includes("://")) {
    try {
      const parsed = new URL(broker);
      if (!parsed.hostname || !parsed.port) {
        throw new Error();
      }
      return `${parsed.hostname}:${parsed.port}`;
    } catch {
      throw new Error(
        `Invalid KAFKA_BROKERS entry: "${rawBroker}". Use host:port format.`,
      );
    }
  }

  const [host, port] = broker.split(":");
  if (!host || !port || !Number.isInteger(Number(port))) {
    throw new Error(
      `Invalid KAFKA_BROKERS entry: "${rawBroker}". Use host:port format.`,
    );
  }

  return `${host}:${Number(port)}`;
}

const renderExternalUrl = process.env.RENDER_EXTERNAL_URL;
const localBaseUrl = `http://localhost:${process.env.PORT ?? 8000}`;
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? renderExternalUrl ?? localBaseUrl;

export const config = {
  port: numberFromEnv("PORT", 8000),
  publicBaseUrl,
  database: {
    url: process.env.DATABASE_URL ?? "",
    ssl: booleanFromEnv("DATABASE_SSL", true),
  },
  kafka: {
    clientId: process.env.KAFKA_CLIENT_ID ?? "live-location-tracker",
    brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092")
      .split(",")
      .map(normalizeKafkaBroker)
      .filter(Boolean),
    topic: process.env.KAFKA_LOCATION_TOPIC ?? "location-updates",
    ssl: booleanFromEnv("KAFKA_SSL", false),
    caCert: normalizePemFromEnv("KAFKA_CA_CERT"),
    clientCert: normalizePemFromEnv("KAFKA_CLIENT_CERT"),
    clientKey: normalizePemFromEnv("KAFKA_CLIENT_KEY"),
    username: process.env.KAFKA_USERNAME ?? "",
    password: process.env.KAFKA_PASSWORD ?? "",
    saslMechanism: process.env.KAFKA_SASL_MECHANISM ?? "plain",
  },
  oidc: {
    issuer: process.env.OIDC_ISSUER ?? publicBaseUrl,
    clientId: process.env.OIDC_CLIENT_ID ?? "live-location-web",
    redirectUri: process.env.OIDC_REDIRECT_URI ?? `${publicBaseUrl}/callback`,
    tokenTtlSeconds: numberFromEnv("TOKEN_TTL_SECONDS", 3600),
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    stateSigningSecret:
      process.env.GOOGLE_STATE_SIGNING_SECRET ?? process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ??
      `${publicBaseUrl}/auth/google/callback`,
  },
  location: {
    updateIntervalMs: numberFromEnv("LOCATION_UPDATE_INTERVAL_MS", 5000),
    staleUserAfterMs: numberFromEnv("STALE_USER_AFTER_MS", 30000),
    maxAccuracyMeters: numberFromEnv("MAX_LOCATION_ACCURACY_METERS", 1000),
    historyFile: path.resolve(
      process.env.LOCATION_HISTORY_FILE ?? "./data/location-history.jsonl",
    ),
  },
};
