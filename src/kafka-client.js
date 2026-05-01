import { Kafka, Partitioners, logLevel } from "kafkajs";
import { config } from "./config.js";

const kafkaConnection = {
  clientId: config.kafka.clientId,
  brokers: config.kafka.brokers,
  logLevel: logLevel.INFO,
};

if (config.kafka.ssl) {
  kafkaConnection.ssl = config.kafka.caCert
    ? { ca: [config.kafka.caCert] }
    : true;
}

if (config.kafka.username && config.kafka.password) {
  kafkaConnection.sasl = {
    mechanism: config.kafka.saslMechanism,
    username: config.kafka.username,
    password: config.kafka.password,
  };
}

export const kafkaClient = new Kafka(kafkaConnection);

export const producerOptions = {
  createPartitioner: Partitioners.LegacyPartitioner,
};
