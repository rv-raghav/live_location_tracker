import crypto from "node:crypto";
import { config } from "./config.js";

const seenEvents = new Map();

function isFiniteCoordinate(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function normalizeLocationEvent({ payload, user, socketId }) {
  const latitude = Number(payload?.latitude);
  const longitude = Number(payload?.longitude);
  const accuracy = payload?.accuracy == null ? null : Number(payload.accuracy);

  if (!isFiniteCoordinate(latitude) || latitude < -90 || latitude > 90) {
    throw new Error("Latitude must be a number between -90 and 90.");
  }

  if (!isFiniteCoordinate(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("Longitude must be a number between -180 and 180.");
  }

  if (
    accuracy !== null &&
    (!Number.isFinite(accuracy) ||
      accuracy < 0 ||
      accuracy > config.location.maxAccuracyMeters)
  ) {
    throw new Error(
      `Accuracy must be between 0 and ${config.location.maxAccuracyMeters} meters.`,
    );
  }

  const eventId =
    typeof payload?.eventId === "string" && payload.eventId.length <= 120
      ? payload.eventId
      : crypto.randomUUID();

  return {
    eventId,
    userId: user.sub,
    userName: user.name || user.email,
    email: user.email,
    socketId,
    latitude,
    longitude,
    accuracy,
    clientSentAt: payload?.sentAt ?? null,
    serverReceivedAt: new Date().toISOString(),
  };
}

export function isDuplicateEvent(event) {
  const dedupeKey = `${event.userId}:${event.eventId}`;
  const now = Date.now();

  for (const [key, expiresAt] of seenEvents) {
    if (expiresAt <= now) seenEvents.delete(key);
  }

  if (seenEvents.has(dedupeKey)) return true;

  seenEvents.set(dedupeKey, now + 2 * 60 * 1000);
  return false;
}
