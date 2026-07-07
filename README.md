# B.A.A.L.
### Behavioral Anticipatory Autonomy Layer

> *"He was offered to the sea. He refused. He declared war on every ally who agreed to the offering. He won. Alone. With Anat beside him."*

B.A.A.L. is an agentic cognitive protection daemon that infers pre-conscious intent and intervenes before behavioral deviation executes. Named for the Ugaritic storm deity — Cloud Rider, Storm Rider — who operates in the atmospheric layer between earth and heaven, between raw signal and conscious act.

---

## Architecture

B.A.A.L. runs a continuous ReAct loop (Reason → Act → Observe) across concurrent subject sessions:

```
OBSERVING → INFERRING → PLANNING → DECLARING → EXECUTING → EVALUATING
                                       |
                                    VETOED (AnatBoundary)
```

### System Components

| Module | Role | Mythological Layer |
|---|---|---|
| `GazeEngine` | Reads 7 behavioral dimensions, computes Z-score deviation | The Gaze |
| `StormEngine` | Infers pre-conscious intent from deviation patterns | The Storm |
| `CloudPlanner` | Constructs multi-step intervention sequences | The Cloud Layer |
| `WarExecutor` | Executes interventions, monitors resolution | The War |
| `ResolutionMonitor` | Redis pub/sub closed-loop feedback | The Watch |
| `AnatBoundary` | Ethical veto authority — NeuroShield | Anat |
| `BaselineVault` | PostgreSQL behavioral memory | The Vault |
| `AgentMemory` | In-process sliding window history | The Memory |
| `EventQueue` | RabbitMQ ingestion topology | The Signal Feed |
| `BaalLogger` | Phase-tagged structured logging | The Voice |

### The Seven Dimensions of the Gaze

| Dimension | What It Reads |
|---|---|
| `cognitive_load` | Processing demand indicators |
| `emotional_valence` | Positive/negative affective state |
| `arousal_level` | Activation and alertness |
| `decision_velocity` | Speed of choice-making |
| `attention_vector` | Focus direction and stability |
| `system_mode` | System 1 (fast) vs System 2 (analytical) |
| `hesitation_index` | Pre-action pause signature |

### Intervention Escalation Ladder

```
INTENSITY 1 — WHISPER    Imperceptible, pre-conscious nudge
INTENSITY 2 — NUDGE      Subtle suggestion, below conscious threshold
INTENSITY 3 — SIGNAL     Noticeable but gentle
INTENSITY 4 — PROMPT     Explicit conscious engagement
INTENSITY 5 — OVERRIDE   NEVER AUTONOMOUS — ANAT VETO ABSOLUTE
```

---

## The Mythology

Baal in the Ugaritic Cycle is the storm deity — *rkb 'rpt*, Rider of Clouds — who operates in the atmospheric layer between earth and heaven. When the divine assembly offered him to Yam (god of chaos), he refused. He declared war on chaos and on every ally who agreed to the sacrifice. He won alone, with his sister Anat — goddess of war — fighting beside him. He was later demonized by Abrahamic tradition. Renamed Beelzebub. Stripped of divinity.

B.A.A.L. carries this arc deliberately:

- **The Gaze** — Baal sees everything from the cloud layer
- **The Storm** — deviation patterns reveal intent before subjects know their own next move
- **Anat** — the NeuroShield ethical enforcement layer with absolute veto authority
- **The Demonization** — a system that protects cognitive autonomy will always be mischaracterized as surveillance by those who benefit from cognitive capture

---

## Infrastructure

| Service | Purpose |
|---|---|
| PostgreSQL | Behavioral baselines, intervention log, consent records |
| RabbitMQ | Event ingestion (EEG, behavioral, biometric, interaction) |
| Redis | Ephemeral resolution pub/sub — closed-loop feedback |

### Try it in 60 seconds — no infrastructure

```bash
npm install
npm run demo
```

The demo runs the real pipeline against in-memory services and walks one
synthetic subject through the entire lifecycle: calibration → consent →
a whisper-level overload intervention → a panic ladder escalating to a
caregiver alert → consent revocation → veto → escalation-desk acknowledgment.

### Run the full stack

```bash
docker compose up -d --wait                 # infrastructure only
cp .env.example .env                        # then set BAAL_INGEST_KEYS etc.
npm start

# — or everything in containers —
export BAAL_INGEST_KEYS='{"my-producer":{"secret":"change-me-32-chars-minimum"}}'
export BAAL_ADMIN_TOKEN='change-me-admin-token'
docker compose --profile full up --build
```

Schema migrations in `db/migrations/*.sql` run automatically at startup and
are recorded in `schema_migrations`.

### Send signals — producer SDK

```js
import { BaalProducer } from './src/client/BaalProducer.js';

const producer = await BaalProducer.connect({
  url: 'amqp://localhost',
  keyId: 'my-producer',                    // must match a BAAL_INGEST_KEYS entry
  secret: process.env.MY_PRODUCER_SECRET,  // signing is handled for you
});
await producer.emit({
  subjectId: 'subject-42',
  source: 'biometric',                     // behavioral | eeg | biometric | interaction
  type: 'heart_rate',
  payload: { heartRate: 96, arousal: 0.7 },
});
await producer.close();
```

### Manage subjects and consent — baalctl

```bash
node bin/baalctl.js enroll subject-42
node bin/baalctl.js consent grant subject-42 --modalities haptic,auditory --max-intensity 3
node bin/baalctl.js baseline subject-42        # watch calibration progress
node bin/baalctl.js status                     # daemon + dependency health
node bin/baalctl.js escalations                # pending human-oversight items
node bin/baalctl.js escalations ack <id> --actor you@example.com
node bin/baalctl.js abort subject-42           # kill an in-flight intervention
node bin/baalctl.js consent revoke subject-42
node bin/baalctl.js erase subject-42 --yes     # right-to-erasure
```

Subject lifecycle: a subject's first signal auto-enrolls them **without
consent** — the daemon observes and calibrates (`BAAL_MIN_BASELINE_SAMPLES`
signals) but vetoes every intervention (`CONSENT_NOT_ESTABLISHED`) until
consent is granted. This is intentional and fail-closed.

### Real notifications

Set `BAAL_NOTIFY_WEBHOOK_URL` to any JSON webhook (Slack, ntfy.sh, …) and
caregiver alerts / notification steps POST there instead of the built-in
stub. A failed webhook surfaces as `escalationFailed` — never silently
swallowed. Other modalities (haptic, auditory, …) remain stubs to replace
with your actuator integrations in `src/execution/adapters/`.

---

## Security model

**Producer authentication.** Every ingested event must be HMAC-SHA256 signed
over its raw bytes by a key from `BAAL_INGEST_KEYS`; keys are optionally
scoped to specific sources (`biometric`, `eeg`, …). Unsigned, tampered, or
out-of-scope events are dead-lettered before they touch a subject. Auth is
mandatory in production — the process refuses to start without keys.

**Admin API.** Mutating operator routes require `Authorization: Bearer
$BAAL_ADMIN_TOKEN` (constant-time compared). With no token configured they
are disabled outright — never open.

**Kill switches.** Consent is re-verified between every ladder step, so a
revocation stops stimulation mid-intervention (outcome `ABORTED`, zero
baseline adaptation). Operators can abort per subject or globally.

**Baseline governance.** New subjects calibrate for
`BAAL_MIN_BASELINE_SAMPLES` signals before any inference runs. Once
calibrated, a reference mean is pinned per dimension; if the adaptive mean
drifts beyond ±0.2 from its reference (slow poisoning, sensor degradation),
adaptation freezes and a drift metric fires.

Not defended: a compromised producer-key holder can forge events for its
permitted sources; key rotation and actuator-side security are deployment
concerns.

---

## Operations

### Health, metrics & admin

A localhost-only HTTP server (configurable via `BAAL_HEALTH_PORT` / `BAAL_HEALTH_HOST`):

| Endpoint | Behavior |
|---|---|
| `GET /health` | `200` when Postgres, RabbitMQ, and Redis are all reachable; `503 degraded` otherwise |
| `GET /metrics` | Counters: interventions, vetoes, drops, aborts, drift, holdout vs treated resolution rates |
| `GET /escalations` | Pending human-oversight escalations |
| `POST /escalations/{id}/ack` | Acknowledge an escalation *(token)* |
| `POST /abort/{subjectId}` | Kill an in-flight intervention *(token)* |
| `DELETE /subjects/{subjectId}` | Right-to-erasure: aborts, then removes every trace *(token)* |

### Human oversight loop

Vetoes and mandated notifications publish to `baal.escalation`; the
**EscalationDesk** consumes them, records each with an acknowledgment
deadline (15 min default), and pages via the `onOverdue` hook when a deadline
lapses. `requiresAck` is now enforced, not decorative.

### Outcome attribution

With `BAAL_HOLDOUT_PCT` set, a deterministic slice of would-be interventions
silently observes instead of acting, measuring the natural resolution rate.
`/metrics` reports `efficacy.treatedRate` vs `efficacy.naturalRate`. High-risk
intents (panic, rage, suppression) are never held out.

### Consent lifecycle

Subjects are auto-enrolled on their first signal **without consent** — every
intervention is vetoed (`CONSENT_NOT_ESTABLISHED`) until consent is activated:

```js
await vault.activateConsent(subjectId, ['haptic', 'auditory'], Intensity.SIGNAL);
await vault.revokeConsent(subjectId);   // immediate, fail-closed
```

Consent is checked on every cycle: active flag, opt-out, expiry timestamp,
per-modality grants, and the intensity ceiling.

### Failure policy

| Failure | Behavior |
|---|---|
| Unsigned / tampered / unauthorized event | Dead-lettered before processing |
| Malformed / stale / future-dated event | Dead-lettered to `baal.dlq`, never processed |
| Duplicate event (redelivery) | Deduped in memory and durably by `eventId` — commits nothing twice |
| Out-of-order signal for a subject | Dropped — never rewinds baseline or resolution state |
| Handler error (e.g. DB blip) | Redelivered once, then dead-lettered — no poison loops |
| Concurrent signals for one subject | Perception always runs; only one intervention in flight per subject (Redis lock across replicas), later signals feed the open resolution window |
| Redis lock service unreachable | Observe only, no stimulation (fail closed) |
| Consent revoked mid-ladder | Intervention aborts before the next stimulating step |
| Baseline drift beyond pinned reference | Adaptation frozen, drift metric raised |
| Rate limits after a crash/restart | Enforced from the durable interventions table, not process memory |
| Audit write failure | Logged, never breaks the intervention loop |
| Escalation channel down | Logged, veto still enforced |
| Escalation unacknowledged past deadline | ERROR log + metric + `onOverdue` paging hook |

### Testing

```bash
npm test        # node:test — unit + integration, zero test dependencies
npm run check   # syntax-check every source file
```

The integration suite drives the real Gaze → Storm → Cloud → Anat → War
pipeline against in-memory fakes at the Postgres/RabbitMQ/Redis boundaries.

---

## AnatBoundary — Veto Conditions

| Condition | Result |
|---|---|
| No active consent record | Hard block |
| Subject opted out | Hard block |
| OVERRIDE intensity requested | Hard block — always, no exceptions |
| Rate limit exceeded | Block until window resets |
| Intensity exceeds consented maximum | Block |
| High-risk intent without human notification | Modify plan — prepend human alert |

OVERRIDE is hardcoded blocked. There is no code path from `CloudPlanner` to `WarExecutor` that bypasses `AnatBoundary`. This is architectural, not configurable.

---

## Theoretical Foundation

Grounded in: *The Purpose of Behavioral Modulation and Neural Interfaces in Cognitive and Security-Critical Environments*.

Key concepts implemented:
- **Behavioral baseline fingerprinting** — GazeEngine
- **Pre-conscious intent inference** — StormEngine
- **Closed-loop neurofeedback** — ResolutionMonitor via Redis pub/sub
- **Ouroboros loop defense** — baselines update from raw human signal only, never intervention outputs
- **Neurorights enforcement** — AnatBoundary consent and rate limiting

---

*The storm does not start itself. Someone has to open the gate.*
