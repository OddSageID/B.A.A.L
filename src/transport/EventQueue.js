import amqplib from 'amqplib';

const TOPOLOGY = {
  exchange:     'baal.events',
  exchangeType: 'topic',
  queues: {
    BEHAVIORAL:  { name: 'baal.behavioral',  routingKey: 'event.behavioral.*' },
    EEG:         { name: 'baal.eeg',         routingKey: 'event.eeg.*'        },
    BIOMETRIC:   { name: 'baal.biometric',   routingKey: 'event.biometric.*'  },
    INTERACTION: { name: 'baal.interaction', routingKey: 'event.interaction.*'},
    ESCALATION:  { name: 'baal.escalation',  routingKey: 'escalation.*'       },
    DLQ:         { name: 'baal.dlq',         routingKey: 'dlq.*'              },
  },
  prefetch:    10,
  reconnectMs: 3000,
};

export class EventQueue {
  #connection   = null;
  #channel      = null;
  #consuming    = false;
  #consumerTags = [];

  static async connect(url = process.env.RABBITMQ_URL ?? 'amqp://localhost') {
    const queue = new EventQueue();
    await queue.#connect(url);
    return queue;
  }

  async #connect(url) {
    this.#connection = await amqplib.connect(url);
    this.#channel    = await this.#connection.createChannel();
    await this.#channel.prefetch(TOPOLOGY.prefetch);
    await this.#channel.assertExchange(TOPOLOGY.exchange, TOPOLOGY.exchangeType, { durable: true });
    for (const [, def] of Object.entries(TOPOLOGY.queues)) {
      await this.#channel.assertQueue(def.name, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange':    TOPOLOGY.exchange,
          'x-dead-letter-routing-key': `dlq.${def.name}`,
          'x-message-ttl':             86400000,
        },
      });
      await this.#channel.bindQueue(def.name, TOPOLOGY.exchange, def.routingKey);
    }
    this.#connection.on('error', (err) => console.error('[EventQueue] Connection error', err));
    this.#connection.on('close', ()    => { console.warn('[EventQueue] Connection closed'); this.#consuming = false; });
    console.info('[EventQueue] Connected — topology initialized');
  }

  async consume(handler) {
    if (this.#consuming) throw new Error('Already consuming');
    this.#consuming = true;
    const queuesToConsume = [
      TOPOLOGY.queues.BEHAVIORAL,
      TOPOLOGY.queues.EEG,
      TOPOLOGY.queues.BIOMETRIC,
      TOPOLOGY.queues.INTERACTION,
    ];
    for (const queueDef of queuesToConsume) {
      const { consumerTag } = await this.#channel.consume(queueDef.name, async (msg) => {
        if (!msg) return;
        let event;
        try {
          event = this.#deserialize(msg);
          this.#validate(event);
        } catch (err) {
          console.error('[EventQueue] Malformed message — routing to DLQ', err);
          this.#channel.nack(msg, false, false);
          return;
        }
        try {
          await handler(event);
          this.#channel.ack(msg);
        } catch (err) {
          console.error('[EventQueue] Handler error — requeueing', err);
          this.#channel.nack(msg, false, true);
        }
      }, { noAck: false });
      this.#consumerTags.push(consumerTag);
    }
    console.info('[EventQueue] Consuming from all event queues');
  }

  async publish(event) {
    this.#validate(event);
    const routingKey = `event.${event.source}.${event.type}`;
    const payload    = Buffer.from(JSON.stringify(event));
    this.#channel.publish(TOPOLOGY.exchange, routingKey, payload, {
      persistent:    true,
      contentType:   'application/json',
      timestamp:     Math.floor(event.timestamp / 1000),
      messageId:     event.eventId,
      correlationId: event.subjectId,
    });
  }

  async publishEscalation(escalation) {
    const payload = Buffer.from(JSON.stringify(escalation));
    this.#channel.publish(TOPOLOGY.exchange, `escalation.${escalation.reason}`, payload, {
      persistent: true, contentType: 'application/json',
    });
  }

  #validate(event) {
    if (!event)                                                          throw new Error('Event is null');
    if (typeof event.subjectId !== 'string' || !event.subjectId.trim()) throw new Error('Missing subjectId');
    if (!event.source)                                                   throw new Error('Missing source');
    if (!event.type)                                                     throw new Error('Missing type');
    if (!event.payload || typeof event.payload !== 'object')             throw new Error('Invalid payload');
    if (typeof event.timestamp !== 'number' || event.timestamp <= 0)     throw new Error('Invalid timestamp');
    const ageMs = Date.now() - event.timestamp;
    if (ageMs > 60000) throw new Error(`Event too stale: ${ageMs}ms`);
  }

  #deserialize(msg) {
    return JSON.parse(msg.content.toString('utf8'));
  }

  async close() {
    for (const tag of this.#consumerTags) await this.#channel.cancel(tag);
    await this.#channel.close();
    await this.#connection.close();
    console.info('[EventQueue] Closed gracefully');
  }
}
