import { Kafka, Partitioners, logLevel } from "kafkajs";
import { config } from "./config.js";

const kafkaConnection = {
  clientId: config.kafka.clientId,
  brokers: config.kafka.brokers,
  logLevel: logLevel.INFO,
};

if (config.kafka.ssl) {
  const sslOptions = {};
  if (config.kafka.caCert) sslOptions.ca = [config.kafka.caCert];
  if (config.kafka.clientCert) sslOptions.cert = config.kafka.clientCert;
  if (config.kafka.clientKey) sslOptions.key = config.kafka.clientKey;
  kafkaConnection.ssl = Object.keys(sslOptions).length > 0 ? sslOptions : true;
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
