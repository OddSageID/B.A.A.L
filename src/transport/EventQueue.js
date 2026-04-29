import amqplib from 'amqplib';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_PATH = path.resolve(process.cwd(), 'schemas/behavioral-event.schema.json');
const EVENT_SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

function loadRabbitConfig(configPath = path.resolve(process.cwd(), 'config/rabbitmq.yml')) {
  const lines = fs.readFileSync(configPath, 'utf8').split('\n');
  const cfg = { queues: {} };
  let section = null;
  let queue = null;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!line.startsWith(' ') && line.includes(':')) {
      const [k, v] = line.split(':').map((s) => s.trim());
      if (k === 'queues') { section = 'queues'; continue; }
      cfg[k] = /^\d+$/.test(v) ? Number(v) : v;
      section = null;
      continue;
    }
    if (section === 'queues' && line.startsWith('  ') && line.trim().endsWith(':') && !line.startsWith('    ')) {
      queue = line.trim().slice(0, -1);
      cfg.queues[queue] = {};
      continue;
    }
    if (queue && line.startsWith('    ') && line.includes(':')) {
      const [k, v] = line.trim().split(':').map((s) => s.trim());
      cfg.queues[queue][k] = v;
    }
  }
  return cfg;
}

const TOPOLOGY = loadRabbitConfig();

export class EventQueue {
  #connection = null;
  #channel = null;
  #consuming = false;
  #consumerTags = [];

  static async connect(url = process.env.RABBITMQ_URL ?? 'amqp://localhost') {
    const queue = new EventQueue();
    await queue.#connect(url);
    return queue;
  }

  async #connect(url) {
    this.#connection = await amqplib.connect(url);
    this.#channel = await this.#connection.createChannel();
    await this.#channel.prefetch(TOPOLOGY.prefetch);
    await this.#channel.assertExchange(TOPOLOGY.exchange, TOPOLOGY.exchangeType, { durable: true });
    for (const [, def] of Object.entries(TOPOLOGY.queues)) {
      await this.#channel.assertQueue(def.name, { durable: true, arguments: { 'x-dead-letter-exchange': TOPOLOGY.exchange, 'x-dead-letter-routing-key': `dlq.${def.name}`, 'x-message-ttl': 86400000 } });
      await this.#channel.bindQueue(def.name, TOPOLOGY.exchange, def.routingKey);
    }
  }

  async consume(handler) {
    if (this.#consuming) throw new Error('Already consuming');
    this.#consuming = true;
    const queuesToConsume = [TOPOLOGY.queues.BEHAVIORAL, TOPOLOGY.queues.EEG, TOPOLOGY.queues.BIOMETRIC, TOPOLOGY.queues.INTERACTION];
    for (const queueDef of queuesToConsume) {
      const { consumerTag } = await this.#channel.consume(queueDef.name, async (msg) => {
        if (!msg) return;
        let event;
        try { event = this.#deserialize(msg); this.#validate(event); }
        catch (err) { this.#channel.nack(msg, false, false); return; }
        try { await handler(event); this.#channel.ack(msg); }
        catch (_) { this.#channel.nack(msg, false, true); }
      }, { noAck: false });
      this.#consumerTags.push(consumerTag);
    }
  }

  async publish(event) {
    this.#validate(event);
    const routingKey = `event.${event.source}.${event.type}`;
    const payload = Buffer.from(JSON.stringify(event));
    this.#channel.publish(TOPOLOGY.exchange, routingKey, payload, { persistent: true, contentType: 'application/json', timestamp: Math.floor(event.timestamp / 1000), messageId: event.eventId, correlationId: event.subjectId });
  }

  #validate(event) {
    if (!event || typeof event !== 'object') throw new Error('Event is null');
    for (const key of EVENT_SCHEMA.required ?? []) {
      if (event[key] == null) throw new Error(`Missing ${key}`);
    }
    if (typeof event.eventId !== 'string' || !event.eventId) throw new Error('Missing eventId');
    if (typeof event.subjectId !== 'string' || !event.subjectId.trim()) throw new Error('Missing subjectId');
    const allowedSources = EVENT_SCHEMA.properties?.source?.enum ?? [];
    if (!allowedSources.includes(event.source)) throw new Error('Invalid source');
    if (typeof event.type !== 'string' || !event.type) throw new Error('Missing type');
    if (!event.payload || typeof event.payload !== 'object') throw new Error('Invalid payload');
    if (typeof event.timestamp !== 'number' || event.timestamp <= 0) throw new Error('Invalid timestamp');
  }

  #deserialize(msg) { return JSON.parse(msg.content.toString('utf8')); }

  health() { return { connected: Boolean(this.#connection && this.#channel) }; }

  async close() {
    for (const tag of this.#consumerTags) await this.#channel.cancel(tag);
    await this.#channel.close();
    await this.#connection.close();
    this.#channel = null;
    this.#connection = null;
  }
}
