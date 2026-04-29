import { BaalAgent } from './src/agent/BaalAgent.js';

const agent = new BaalAgent({
  maxConcurrentSubjects: parseInt(process.env.BAAL_MAX_SUBJECTS  ?? '50'),
  inferenceThreshold:    parseFloat(process.env.BAAL_THRESHOLD   ?? '0.72'),
  planningDepth:         parseInt(process.env.BAAL_PLAN_DEPTH    ?? '3'),
  gazeIntervalMs:        parseInt(process.env.BAAL_GAZE_INTERVAL ?? '500'),
  memoryWindowHours:     parseInt(process.env.BAAL_MEMORY_HOURS  ?? '24'),
});

async function main() {
  process.on('SIGTERM', async () => { await agent.shutdown(); process.exit(0); });
  process.on('SIGINT',  async () => { await agent.shutdown(); process.exit(0); });
  process.on('unhandledRejection', (reason) => console.error('[BAAL] Unhandled rejection', reason));
  await agent.initialize();
  await agent.run();
}

main().catch((err) => { console.error('[BAAL] Fatal startup error', err); process.exit(1); });
