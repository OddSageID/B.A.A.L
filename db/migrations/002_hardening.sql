-- Durable idempotency: signal events carry the originating eventId.
ALTER TABLE signal_events ADD COLUMN IF NOT EXISTS event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_events_event_id
  ON signal_events (event_id) WHERE event_id IS NOT NULL;

-- Audit reconstructability: which rule/strategy versions produced a decision.
ALTER TABLE interventions ADD COLUMN IF NOT EXISTS ruleset_version  TEXT;
ALTER TABLE interventions ADD COLUMN IF NOT EXISTS strategy_version TEXT;

-- Outcome attribution: holdout cycles observe without intervening.
ALTER TABLE interventions ADD COLUMN IF NOT EXISTS holdout BOOLEAN NOT NULL DEFAULT false;

-- Baseline poisoning defense: pin a reference once calibration completes.
ALTER TABLE baselines ADD COLUMN IF NOT EXISTS reference_mean      NUMERIC;
ALTER TABLE baselines ADD COLUMN IF NOT EXISTS reference_pinned_at TIMESTAMPTZ;

-- Human oversight: escalations are tracked until acknowledged.
CREATE TABLE IF NOT EXISTS escalations (
  id                 TEXT        PRIMARY KEY,
  subject_id         TEXT        NOT NULL,
  reason             TEXT        NOT NULL,
  intent_class       TEXT,
  payload            JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ack_deadline       TIMESTAMPTZ NOT NULL,
  acked_at           TIMESTAMPTZ,
  acked_by           TEXT,
  overdue_alerted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_escalations_pending
  ON escalations (ack_deadline) WHERE acked_at IS NULL;

-- Durable rate limiting reads from interventions.
CREATE INDEX IF NOT EXISTS idx_interventions_rate
  ON interventions (subject_id, executed_at) WHERE vetoed = false AND holdout = false;
