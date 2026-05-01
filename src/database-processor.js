import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { kafkaClient } from "./kafka-client.js";

const buffer = [];

async function flushHistory() {
  if (buffer.length === 0) return;

  const events = buffer.splice(0, buffer.length);
  await fs.mkdir(path.dirname(config.location.historyFile), { recursive: true });
  await fs.appendFile(
    config.location.historyFile,
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  console.log(`Persisted ${events.length} location event(s) to ${config.location.historyFile}`);
}

async function main() {
  const consumer = kafkaClient.consumer({
    groupId: "database-processor",
  });

  await consumer.connect();
  await consumer.subscribe({
    topic: config.kafka.topic,
    fromBeginning: false,
  });

  setInterval(() => {
    flushHistory().catch((error) => {
      console.error("Failed to flush location history", error);
    });
  }, 5000);

  await consumer.run({
    eachMessage: async ({ message, heartbeat }) => {
      const event = JSON.parse(message.value.toString());
      buffer.push({
        eventId: event.eventId,
        userId: event.userId,
        userName: event.userName,
        latitude: event.latitude,
        longitude: event.longitude,
        accuracy: event.accuracy,
        clientSentAt: event.clientSentAt,
        serverReceivedAt: event.serverReceivedAt,
        processedAt: new Date().toISOString(),
      });

      if (buffer.length >= 25) {
        await flushHistory();
      }

      await heartbeat();
    },
  });
}

process.on("SIGINT", async () => {
  await flushHistory();
  process.exit(0);
});

main().catch((error) => {
  console.error("Database processor failed", error);
  process.exitCode = 1;
});
