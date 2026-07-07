import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = fileURLToPath(new URL('../../schemas/behavioral-event.schema.json', import.meta.url));
const EVENT_SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

const ALLOWED_SOURCES = EVENT_SCHEMA.properties?.source?.enum ?? [];
const PAYLOAD_BOUNDS  = EVENT_SCHEMA.properties?.payload?.properties ?? {};
const MAX_ID_LENGTH   = 256;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export class EventValidationError extends Error {
  constructor(message) { super(message); this.name = 'EventValidationError'; }
}

const fail = (message) => { throw new EventValidationError(message); };

/**
 * Validates a behavioral event against the JSON schema contract.
 * maxAgeMs: reject events older than this (0 disables the staleness gate —
 * a real-time intervention system must not act on stale signals by default).
 */
export function validateEvent(event, { maxAgeMs = 60000, now = Date.now() } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail('Event must be an object');
  for (const key of EVENT_SCHEMA.required ?? []) {
    if (event[key] == null) fail(`Missing required field: ${key}`);
  }
  if (typeof event.eventId !== 'string' || !event.eventId.trim())     fail('Invalid eventId');
  if (event.eventId.length > MAX_ID_LENGTH)                           fail('eventId too long');
  if (typeof event.subjectId !== 'string' || !event.subjectId.trim()) fail('Invalid subjectId');
  if (event.subjectId.length > MAX_ID_LENGTH)                         fail('subjectId too long');
  if (!ALLOWED_SOURCES.includes(event.source))                        fail(`Invalid source: ${event.source}`);
  if (typeof event.type !== 'string' || !event.type.trim())           fail('Invalid type');
  if (event.type.length > MAX_ID_LENGTH)                              fail('type too long');
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) fail('Invalid payload');
  if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp) || event.timestamp <= 0) fail('Invalid timestamp');
  if (event.timestamp - now > MAX_FUTURE_SKEW_MS) fail(`Timestamp too far in the future: ${event.timestamp}`);
  if (maxAgeMs > 0 && now - event.timestamp > maxAgeMs) fail(`Event too stale: ${now - event.timestamp}ms old`);

  for (const [key, bounds] of Object.entries(PAYLOAD_BOUNDS)) {
    const value = event.payload[key];
    if (value == null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`payload.${key} must be a finite number`);
    if (bounds.minimum != null && value < bounds.minimum)     fail(`payload.${key} below minimum ${bounds.minimum}`);
    if (bounds.maximum != null && value > bounds.maximum)     fail(`payload.${key} above maximum ${bounds.maximum}`);
  }
  return event;
}
