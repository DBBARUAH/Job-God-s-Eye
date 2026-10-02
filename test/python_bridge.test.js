import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBridge, defaultPython, BRIDGE_SCRIPT } from '../src/python_bridge.js';

const fake = fileURLToPath(new URL('./fixtures/fake_bridge.mjs', import.meta.url));
const node = { python: process.execPath, pythonArgs: [], script: fake };
const run = (name, options = {}, extra = {}) => runBridge({ mode: 'status', args: { case: name, ...extra } }, { ...node, ...options });

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitDead(pid, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

test('default interpreter is the project venv for each platform', () => {
  assert.equal(defaultPython('/p', 'darwin'), path.join('/p', '.venv', 'bin', 'python'));
  assert.equal(defaultPython('/p', 'linux'), path.join('/p', '.venv', 'bin', 'python'));
  assert.equal(defaultPython('C:\\p', 'win32'), path.join('C:\\p', '.venv', 'Scripts', 'python.exe'));
  assert.ok(path.isAbsolute(BRIDGE_SCRIPT));
  assert.match(BRIDGE_SCRIPT, /python[\\/]bridge\.py$/);
});

test('round-trips one JSON request and ignores stderr diagnostics', async () => {
  const result = await run('echo');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.echo, { mode: 'status', args: { case: 'echo' } });
  assert.equal(result.env.PYTHONNOUSERSITE, '1');
  const noisy = await run('stderr');
  assert.deepEqual(noisy, { status: 'ok' });
  assert.doesNotMatch(JSON.stringify(noisy), /jane/);
});

test('malformed, multi-line, non-object and unknown-status output is rejected', async () => {
  for (const name of ['malformed', 'two_lines', 'array', 'bad_status', 'invalid_utf8']) {
    assert.deepEqual(await run(name), { status: 'error', reason: 'malformed_bridge_response' }, name);
  }
  assert.deepEqual(await run('exit1'), { status: 'error', reason: 'bridge_process_failed' });
});

test('response size cap kills the process', async () => {
  assert.deepEqual(await run('big', { maxBytes: 1024 }), { status: 'error', reason: 'bridge_response_too_large' });
});

test('missing or relative interpreters fail closed without a shell', async () => {
  assert.deepEqual(await runBridge({ mode: 'status' }, { python: 'python3' }), { status: 'unavailable', reason: 'python_path_not_absolute' });
  const missing = path.join(os.tmpdir(), 'definitely-missing-python-7c1e', 'python');
  assert.deepEqual(await runBridge({ mode: 'status' }, { python: missing }), { status: 'unavailable', reason: 'python_unavailable' });
  let options;
  await runBridge({ mode: 'status' }, { ...node, spawnImpl: (cmd, args, opts) => { options = opts; throw new Error('no spawn'); } });
  assert.equal(options.shell, false);
});

test('timeout kills the bridge and its grandchildren', { skip: process.platform === 'win32' && 'POSIX process groups', timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-timeout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, 'pid');
  const started = Date.now();
  const result = await run('hang', { timeoutMs: 800 }, { pidFile });
  assert.deepEqual(result, { status: 'network_error', reason: 'bridge_timeout' });
  assert.ok(Date.now() - started < 8000);
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.ok(await waitDead(pid), 'grandchild should be killed');
});

test('normal exit still cleans up orphaned group members', { skip: process.platform === 'win32' && 'POSIX process groups', timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bridge-orphan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, 'pid');
  assert.deepEqual(await run('orphan', { timeoutMs: 10000 }, { pidFile }), { status: 'ok' });
  assert.ok(await waitDead(Number(await readFile(pidFile, 'utf8'))), 'orphan should be killed');
});

const venvPython = process.env.FINANCE_JOB_PYTHON ?? defaultPython();
test('real Python bridge: status and strict input validation (offline)', { skip: !existsSync(venvPython) && 'project .venv not installed', timeout: 60000 }, async () => {
  const status = await runBridge({ mode: 'status' }, { python: venvPython });
  assert.ok(['ok', 'unavailable'].includes(status.status));
  assert.equal(typeof status.capabilities.jobs, 'boolean');
  assert.equal(status.sessionPersistence, false);
  assert.deepEqual(await runBridge({ mode: 'jobs', args: { searchTerm: 'risk', limit: 99 } }, { python: venvPython }),
    { status: 'invalid_request', reason: 'invalid_limit' });
  assert.deepEqual(await runBridge({ mode: 'profile', args: { url: 'https://www.linkedin.com/in/example' } }, { python: venvPython }),
    { status: 'auth_required', reason: 'interactive_login_required', interactiveLoginRequired: true, sessionPersistence: false });
});
