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
    DLQ:         { name: 'baal.dlq',         routingKey: 'dlq.*'               },
  }),
});
