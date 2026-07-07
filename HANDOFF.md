# B.A.A.L. — Handoff & Next Steps

State at handoff: **v0.4.0**, branch `claude/scaffold-baal-project-WXDLE`, PR #2 open.
119 tests passing on Node 20/22 (`npm test`), zero runtime-dependency vulnerabilities,
end-to-end demo runs without infrastructure (`npm run demo`).

The guiding principle of everything below: **sequence by risk**. Prove the
riskiest untested assumption at each phase before building on top of it.

---

## Phase 0 — Take ownership (first day)

1. **Review and merge PR #2.** The three commits to read, in order:
   `c4d8d7f`/`0374377` (core hardening + test suite), `ba9a2a0` (the 11
   design-gap fixes — this is the security-critical one), `66fa56e`
   (user-facing surfaces).
2. **Run it yourself:** `npm install && npm test && npm run demo`. If the
   demo's five scenarios make sense to you, you understand the system.
3. **Mint real secrets.** Generate a producer key (≥32 random chars) for
   `BAAL_INGEST_KEYS` and an admin token for `BAAL_ADMIN_TOKEN`. Store them
   in a secret manager, never in the repo. `.env.example` documents the shape.
4. **Docker smoke test** — *the one thing never executed during development*
   (no Docker in the dev environment):
   ```bash
   export BAAL_INGEST_KEYS='{"smoke":{"secret":"<32+ chars>"}}'
   export BAAL_ADMIN_TOKEN='<16+ chars>'
   docker compose --profile full up --build
   node bin/baalctl.js status        # expect: daemon ok, all deps connected
   ```
   Expected failure modes if something's off: image build errors (Dockerfile
   COPY list), migration errors on first boot (002_hardening.sql), or the
   daemon exiting because production mode demands ingest keys (that one is
   intentional).

## Phase 1 — Prove the live transport path (week 1)

The in-memory tests prove the pipeline logic; they deliberately fake the three
services. These behaviors are **implemented but unverified against real
brokers**, and each has a specific check:

| Untested assumption | How to verify |
|---|---|
| Signature headers survive AMQP round-trip | `BaalProducer.emit()` → daemon log shows event processed; tamper one byte → lands in `baal.dlq` |
| Poison-message policy | Throw inside a handler once → message redelivers once, then dead-letters |
| Durable dedup | Publish the same `eventId` twice → one `signal_events` row |
| Migration 002 on a fresh AND an existing 001-only database | Boot against both; check `schema_migrations` |
| Redis lock under contention | Run two daemon instances, flood one subject → exactly one intervention (grep for "held by another instance") |
| Escalation desk consumes the real queue | Trigger a veto → `baalctl escalations` shows it |

**Status: automated.** `tests/live/transport.live.test.js` covers every row of
this table and the CI `live` job runs it against real service containers on
every push — check the Actions tab on PR #2 for the first execution. To use
the same suite as a staging soak, point the env at staging:

```bash
BAAL_LIVE=1 RABBITMQ_URL=… PGHOST=… REDIS_URL=… npm run test:live
```

What remains manual in this phase: reviewing the first CI `live` run, and the
two-instance lock-contention check (the CI test proves contention semantics on
one host; running two daemon processes against one broker is a 5-minute manual
check with `docker compose --profile full up --scale baal=2`).

## Phase 2 — One real signal in, one real action out (weeks 2–4)

Do not integrate five sensors. Pick **one** source and **one** actuator and
close a real loop:

- **Source:** keyboard/interaction telemetry is the cheapest honest signal
  (reaction times, error rates, hesitation — maps directly to the existing
  payload fields). Heart rate via BLE if hardware is available.
- **Actuator:** the webhook adapter already works (`BAAL_NOTIFY_WEBHOOK_URL`
  → phone via ntfy.sh). A desktop-notification adapter is the next cheapest.
- **Turn on the holdout arm from day one** (`BAAL_HOLDOUT_PCT=15`). Without
  it you will never know if interventions do anything.

**Critical caveat for this phase:** every threshold in `GazeEngine.THRESHOLDS`
and every rule in `StormEngine.INFERENCE_RULES` is a **plausible guess, not a
validated model**. Expect the first weeks of real data to produce mostly
`UNKNOWN` intents or false positives. That is the system working as designed —
collect the data, then tune rules against it (bump `RULESET_VERSION` when you
do; the audit trail depends on it).

## Phase 3 — Operate like you mean it (ongoing)

- Wire `EscalationDesk`'s `onOverdue` hook to a real pager. Until then, an
  ignored escalation only produces a log line and a counter.
- Decide governance and write it down: who may run `baalctl consent grant`,
  who acks escalations, who holds the admin token. The code enforces
  mechanism; you must supply policy.
- Postgres backups + a tested restore. The vault is the only durable truth
  (consent, audit, baselines).
- Key rotation procedure for `BAAL_INGEST_KEYS` (add new key → migrate
  producers → remove old).

---

## Known limitations (deliberate, documented, not bugs)

1. **Single-instance perception.** The Redis lock makes *interventions* safe
   across replicas, but sessions/ordering-guard/metrics are per-process.
   True horizontal scale needs subject-sharded queue consumption.
2. **Actuators are stubs** except notification-via-webhook. Haptic/auditory/
   visual integrations are hardware-specific by nature (`src/execution/adapters/`).
3. **Efficacy numbers are naive counters** (`treatedRate` vs `naturalRate`),
   not statistics. Holdout assignment happens *before* the Anat check, so the
   holdout and treated populations differ slightly (documented in
   `BaalAgent.#inHoldout`). Good enough to detect "does nothing"; not good
   enough to publish.
4. **No dashboard.** `baalctl` + `/metrics` JSON is the operator surface.
   Build a UI only when a real operator exists.
5. **No distributed tracing / Prometheus format.** Add when there's more than
   one service to trace.
6. **A compromised producer key can forge events** for its permitted sources.
   Rotation and producer-side security are yours.

## Decision log (the "why" future-you will want)

- **`node:test` over jest** — jest was declared but never installed (the suite
  couldn't run); the built-in runner removed ~270 packages of dev surface.
- **Fail-closed consent everywhere** — unknown subject, missing provider,
  expired record, unlisted modality, or a consent-check *error* all block or
  abort. A cognitive-intervention system must never fail open.
- **One intervention per subject, not a queue** — queued interventions would
  execute against stale deviations, and naive locking deadlocks the
  closed feedback loop (the resolution signal arrives via the *next* event).
  Perception always flows; stimulation is exclusive.
- **HMAC over raw message bytes** (not canonicalized JSON) — canonicalization
  is a bug farm; signing the exact published buffer is unambiguous, and the
  shared header constants live in `EventAuth` so producer/consumer can't drift.
- **Rate limits read from Postgres, not memory** — a crash loop must not
  reset a subject's daily stimulation budget.
- **ABORTED outcome carries zero baseline weight** — an interrupted cycle
  teaches nothing; letting it adapt the baseline would let aborts poison it.

## Map

| Where | What |
|---|---|
| `src/agent/BaalAgent.js` | Orchestrator: ordering guard, calibration/drift gates, holdout, locks, abort registry |
| `src/neuroshield/AnatBoundary.js` | Every consent check, in bypass-proof order |
| `src/transport/` | Queue, topology, schema validation, producer auth |
| `src/client/BaalProducer.js` | How signals get in |
| `bin/baalctl.js` | How humans operate it |
| `demo/run-demo.js` | The living documentation — start here |
| `db/migrations/` | Schema truth; add `003_*.sql`, never edit applied files |
| `tests/integration/BaalAgent.pipeline.test.js` | Behavioral contract of the whole loop |
