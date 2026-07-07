/**
 * RabbitMQ topology for B.A.A.L. event ingestion.
 * Plain data module — no runtime parsing, no CWD dependence.
 */
export const TOPOLOGY = Object.freeze({
  exchange:     'baal.events',
  exchangeType: 'topic',
  prefetch:     10,
  queues: Object.freeze({
    BEHAVIORAL:  { name: 'baal.behavioral',  routingKey: 'event.behavioral.*'  },
    EEG:         { name: 'baal.eeg',         routingKey: 'event.eeg.*'         },
    BIOMETRIC:   { name: 'baal.biometric',   routingKey: 'event.biometric.*'   },
    INTERACTION: { name: 'baal.interaction', routingKey: 'event.interaction.*' },
    ESCALATION:  { name: 'baal.escalation',  routingKey: 'escalation.*'        },
    // '#' not '*': dead-letter routing keys are multi-word (dlq.baal.behavioral)
    // and topic '*' matches exactly one word — with '*' every dead-lettered
    // message is silently dropped by the exchange. Caught by the live suite.
    DLQ:         { name: 'baal.dlq',         routingKey: 'dlq.#'               },
  }),
});
