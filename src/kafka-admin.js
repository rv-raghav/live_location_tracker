import { config } from "./config.js";
import { kafkaClient } from "./kafka-client.js";

async function setupKafka() {
  const admin = kafkaClient.admin();
  await admin.connect();

  const existingTopics = await admin.listTopics();
  if (!existingTopics.includes(config.kafka.topic)) {
    await admin.createTopics({
      topics: [
        {
          topic: config.kafka.topic,
          numPartitions: 3,
          replicationFactor: 1,
        },
      ],
    });
    console.log(`Created Kafka topic: ${config.kafka.topic}`);
  } else {
    console.log(`Kafka topic already exists: ${config.kafka.topic}`);
  }

  await admin.disconnect();
}

setupKafka().catch((error) => {
  console.error("Kafka setup failed", error);
  process.exitCode = 1;
});
