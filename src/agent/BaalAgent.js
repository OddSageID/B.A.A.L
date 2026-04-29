import { GazeEngine }        from '../perception/GazeEngine.js';
import { StormEngine }       from '../inference/StormEngine.js';
import { CloudPlanner }      from '../planning/CloudPlanner.js';
import { WarExecutor }       from '../execution/WarExecutor.js';
import { ResolutionMonitor } from '../execution/ResolutionMonitor.js';
import { AnatBoundary }      from '../neuroshield/AnatBoundary.js';
import { BaselineVault }     from '../memory/BaselineVault.js';
import { AgentMemory }       from '../memory/AgentMemory.js';
import { EventQueue }        from '../transport/EventQueue.js';
import { BaalLogger }        from '../utils/BaalLogger.js';
import { BaalMetrics }       from '../observability/BaalMetrics.js';
import { HealthServer }      from '../observability/HealthServer.js';

export const AgentState = Object.freeze({
  OBSERVING: 'OBSERVING', INFERRING: 'INFERRING', PLANNING: 'PLANNING',
  DECLARING: 'DECLARING', EXECUTING: 'EXECUTING', EVALUATING: 'EVALUATING', VETOED: 'VETOED',
});

const TOOLS = {
  READ_BEHAVIORAL_SIGNAL: 'read_behavioral_signal',
  QUERY_BASELINE:         'query_baseline',
  INFER_INTENT:           'infer_intent',
  PLAN_INTERVENTION:      'plan_intervention',
  CHECK_NEUROSHIELD:      'check_neuroshield',
  EXECUTE_INTERVENTION:   'execute_intervention',
  EVALUATE_OUTCOME:       'evaluate_outcome',
  UPDATE_BASELINE:        'update_baseline',
  ESCALATE_TO_ANAT:       'escalate_to_anat',
};

export class BaalAgent {
  #state = AgentState.OBSERVING;
  #gaze = null; #storm = null; #cloud = null; #war = null;
  #anat = null; #vault = null; #memory = null; #queue = null;
  #monitor = null; #logger = null;
  #subjects = new Map();
  #running  = false;
  #metrics = new BaalMetrics();
  #healthServer = null;
  #startedAt = Date.now();

  constructor(config = {}) {
    this.config = {
      maxConcurrentSubjects: config.maxConcurrentSubjects ?? 50,
      inferenceThreshold:    config.inferenceThreshold    ?? 0.72,
      planningDepth:         config.planningDepth         ?? 3,
      gazeIntervalMs:        config.gazeIntervalMs        ?? 500,
      memoryWindowHours:     config.memoryWindowHours     ?? 24,
      ...config,
    };
    this.#logger = new BaalLogger({ name: 'BaalAgent' });
  }

  async initialize() {
    this.#logger.storm('B.A.A.L. initializing — The Gaze opens');
    this.#vault   = await BaselineVault.connect();
    this.#memory  = new AgentMemory({ windowHours: this.config.memoryWindowHours });
    this.#queue   = await EventQueue.connect();
    this.#gaze    = new GazeEngine({ vault: this.#vault });
    this.#storm   = new StormEngine({ threshold: this.config.inferenceThreshold });
    this.#cloud   = new CloudPlanner({ depth: this.config.planningDepth });
    this.#war     = new WarExecutor();
    this.#anat    = new AnatBoundary({ consentProvider: this.#vault });
    this.#monitor = await ResolutionMonitor.create();
    this.#war.setMonitor(this.#monitor);
    this.#healthServer = new HealthServer({ deps: { vault: this.#vault, queue: this.#queue, monitor: this.#monitor, metrics: this.#metrics, startedAt: this.#startedAt }, port: parseInt(process.env.BAAL_HEALTH_PORT ?? '8787') });
    await this.#healthServer.start();
    this.#logger.storm('B.A.A.L. initialized — The Storm is ready');
  }

  async run() {
    if (this.#running) throw new Error('B.A.A.L. is already running');
    this.#running = true;
    this.#logger.declare('B.A.A.L. agent loop started — The Gaze is open');
    await this.#queue.consume(async (event) => {
      try { await this.#processEvent(event); }
      catch (err) { this.#logger.error('Agent loop error', { event, err }); }
    });
  }

  async #processEvent(event) {
    const { subjectId } = event;
    const session = this.#getOrCreateSession(subjectId);
    this.#logger.gaze('Event received', { subjectId, type: event.type });
    this.#transition(session, AgentState.OBSERVING);
    const signal    = await this.#tool(TOOLS.READ_BEHAVIORAL_SIGNAL, { event, session });
    const baseline  = await this.#tool(TOOLS.QUERY_BASELINE, { subjectId });
    const deviation = this.#gaze.computeDeviation(signal, baseline);
    await this.#monitor.forwardDeviation(subjectId, deviation, signal.timestamp);
    if (!deviation.significant) {
      await this.#tool(TOOLS.UPDATE_BASELINE, { subjectId, signal, weight: 0.05 });
      this.#logger.gaze('No significant deviation', { subjectId });
      return;
    }
    this.#transition(session, AgentState.INFERRING);
    const intent = await this.#tool(TOOLS.INFER_INTENT, { signal, baseline, deviation, history: this.#memory.getHistory(subjectId) });
    this.#logger.storm('Intent inferred', { subjectId, intent });
    this.#transition(session, AgentState.PLANNING);
    const plan = await this.#tool(TOOLS.PLAN_INTERVENTION, { intent, subjectId, sessionContext: session });
    this.#logger.cloud('Plan constructed', { subjectId, steps: plan.steps.length, severity: plan.severity });
    const clearance = await this.#tool(TOOLS.CHECK_NEUROSHIELD, { plan, intent, subjectId });
    if (!clearance.approved) {
      this.#transition(session, AgentState.VETOED);
      this.#logger.anat('Vetoed by Anat', { subjectId, reason: clearance.reason });
      this.#metrics.markVeto(clearance.reason);
      await this.#tool(TOOLS.ESCALATE_TO_ANAT, { plan, intent, subjectId, reason: clearance.reason });
      return;
    }
    this.#transition(session, AgentState.DECLARING);
    this.#logger.declare('War declared — intervention authorized', { subjectId });
    this.#transition(session, AgentState.EXECUTING);
    this.#metrics.markIntervention(intent.primary?.class);
    const result = await this.#tool(TOOLS.EXECUTE_INTERVENTION, { plan, subjectId });
    this.#transition(session, AgentState.EVALUATING);
    const evaluation = await this.#tool(TOOLS.EVALUATE_OUTCOME, { intent, plan, result, subjectId });
    this.#metrics.markResolution(evaluation.outcome);
    await this.#tool(TOOLS.UPDATE_BASELINE, { subjectId, signal, weight: evaluation.outcomeWeight });
    this.#memory.record(subjectId, { intent, plan, result, evaluation });
    this.#logger.declare('Cycle complete', { subjectId, outcome: evaluation.outcome });
    this.#transition(session, AgentState.OBSERVING);
  }

  async #tool(toolName, params) {
    switch (toolName) {
      case TOOLS.READ_BEHAVIORAL_SIGNAL: return this.#gaze.readSignal(params.event, params.session);
      case TOOLS.QUERY_BASELINE:         return this.#vault.getBaseline(params.subjectId);
      case TOOLS.INFER_INTENT:           return this.#storm.infer(params);
      case TOOLS.PLAN_INTERVENTION:      return this.#cloud.plan(params);
      case TOOLS.CHECK_NEUROSHIELD:      return this.#anat.evaluate(params);
      case TOOLS.EXECUTE_INTERVENTION:   return this.#war.execute(params.plan, params.subjectId);
      case TOOLS.EVALUATE_OUTCOME:       return this.#war.evaluate(params);
      case TOOLS.UPDATE_BASELINE:        return this.#vault.updateBaseline(params.subjectId, params.signal, params.weight);
      case TOOLS.ESCALATE_TO_ANAT:       return this.#anat.escalate(params);
      default: throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  #getOrCreateSession(subjectId) {
    if (!this.#subjects.has(subjectId)) {
      this.#subjects.set(subjectId, { subjectId, state: AgentState.OBSERVING, interventions: 0, vetoes: 0, createdAt: Date.now() });
    }
    return this.#subjects.get(subjectId);
  }

  #transition(session, newState) { session.state = newState; }

  async shutdown() {
    this.#running = false;
    await this.#queue.close();
    await this.#vault.disconnect();
    await this.#monitor.shutdown();
    await this.#healthServer?.stop();
    this.#logger.storm('B.A.A.L. shutdown — The Gaze closes');
  }
}
