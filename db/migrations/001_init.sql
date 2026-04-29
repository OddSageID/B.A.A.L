CREATE TABLE IF NOT EXISTS subjects (
  subject_id      TEXT        PRIMARY KEY,
  enrolled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  consent_version INTEGER     NOT NULL DEFAULT 1,
  opted_out       BOOLEAN     NOT NULL DEFAULT false,
  metadata        JSONB
);

CREATE TABLE IF NOT EXISTS baselines (
  id           BIGSERIAL   PRIMARY KEY,
  subject_id   TEXT        NOT NULL REFERENCES subjects(subject_id),
  dimension    TEXT        NOT NULL,
  mean         NUMERIC     NOT NULL,
  std_dev      NUMERIC     NOT NULL DEFAULT 0.1,
  sample_count INTEGER     NOT NULL DEFAULT 1,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_id, dimension)
);

CREATE TABLE IF NOT EXISTS signal_events (
  id          BIGSERIAL   PRIMARY KEY,
  subject_id  TEXT        NOT NULL REFERENCES subjects(subject_id),
  source      TEXT        NOT NULL,
  dimensions  JSONB       NOT NULL,
  deviation   JSONB,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS interventions (
  id             BIGSERIAL   PRIMARY KEY,
  subject_id     TEXT        NOT NULL REFERENCES subjects(subject_id),
  intent_class   TEXT        NOT NULL,
  confidence     NUMERIC     NOT NULL,
  plan           JSONB       NOT NULL,
  result         JSONB,
  outcome        TEXT,
  outcome_weight NUMERIC,
  vetoed         BOOLEAN     NOT NULL DEFAULT false,
  veto_reason    TEXT,
  executed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consent_records (
  id                      BIGSERIAL   PRIMARY KEY,
  subject_id              TEXT        NOT NULL REFERENCES subjects(subject_id),
  active                  BOOLEAN     NOT NULL DEFAULT true,
  opted_out               BOOLEAN     NOT NULL DEFAULT false,
  max_permitted_intensity INTEGER     NOT NULL DEFAULT 3,
  consented_modalities    TEXT[]      NOT NULL DEFAULT '{}',
  consented_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ,
  revoked_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_baselines_subject     ON baselines      (subject_id);
CREATE INDEX IF NOT EXISTS idx_signal_events_subject ON signal_events  (subject_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_interventions_subject ON interventions  (subject_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_interventions_class   ON interventions  (intent_class, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_consent_active        ON consent_records(subject_id, active) WHERE active = true;
