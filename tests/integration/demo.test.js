import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));

describe('user-facing entry points', () => {
  test('the demo runs the full lifecycle end-to-end and exits cleanly', async () => {
    const { stdout } = await run('node', ['demo/run-demo.js', '--quiet'], { cwd: root, timeout: 120000 });
    assert.match(stdout, /CALIBRATION/);
    assert.match(stdout, /CONSENT_NOT_ESTABLISHED/);
    assert.match(stdout, /Outcome: RESOLVED/);
    assert.match(stdout, /Outcome: ESCALATED/);
    assert.match(stdout, /Acknowledged by demo-operator/);
    assert.match(stdout, /DEMO COMPLETE/);
  });

  test('baalctl prints usage and exits 0 with --help', async () => {
    const { stdout } = await run('node', ['bin/baalctl.js', '--help'], { cwd: root, timeout: 30000 });
    assert.match(stdout, /consent grant/);
    assert.match(stdout, /escalations ack/);
  });

  test('baalctl fails fast with a clear message when the daemon is down', async () => {
    await assert.rejects(
      run('node', ['bin/baalctl.js', 'status'], {
        cwd: root, timeout: 30000,
        env: { ...process.env, BAAL_HEALTH_PORT: '1' }, // nothing listens on port 1
      }),
      (err) => /cannot reach B\.A\.A\.L\. admin API/.test(err.stderr)
    );
  });
});
