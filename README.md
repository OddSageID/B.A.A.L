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

### Quick Start

```bash
docker-compose up -d
npm install
cp .env.example .env
npm start
```

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
