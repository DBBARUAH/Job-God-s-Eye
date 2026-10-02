// Runs python/bridge.py as a shell-free child: one JSON request on stdin, one JSON
// line on stdout. stderr is drained and discarded because vendor diagnostics can
// contain personal data. The whole process group is killed afterwards so browser
// children launched by Playwright cannot outlive a request.
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BRIDGE_SCRIPT = path.join(ROOT, 'python', 'bridge.py');
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const TIMEOUTS_MS = Object.freeze({ status: 30_000, jobs: 240_000, profile: 300_000, company_posts: 300_000 });
const KILL_GRACE_MS = 2_000;
const STATUSES = new Set([
  'ok', 'partial', 'no_results', 'blocked', 'rate_limited', 'auth_required', 'network_error',
  'unrecognized_page', 'limit_reached', 'invalid_request', 'unavailable', 'error',
]);

export function defaultPython(root = ROOT, platform = process.platform) {
  return platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return; // Group already gone; do not signal a possibly recycled ID later.
  }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }, KILL_GRACE_MS).unref();
}

function failure(status, reason) {
  return { status, reason };
}

export function runBridge(request, {
  python = process.env.FINANCE_JOB_PYTHON ?? defaultPython(),
  pythonArgs = ['-I'],
  script = BRIDGE_SCRIPT,
  timeoutMs = TIMEOUTS_MS[request?.mode] ?? TIMEOUTS_MS.status,
  maxBytes = MAX_RESPONSE_BYTES,
  spawnImpl = spawn,
} = {}) {
  if (typeof python !== 'string' || !path.isAbsolute(python)) {
    return Promise.resolve(failure('unavailable', 'python_path_not_absolute'));
  }
  let input;
  try {
    input = JSON.stringify(request);
  } catch {
    return Promise.resolve(failure('invalid_request', 'unserializable_request'));
  }
  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl(python, [...pythonArgs, script], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
      });
    } catch {
      resolve(failure('unavailable', 'python_unavailable'));
      return;
    }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let outcome = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      resolve(result);
    };
    const abort = result => {
      outcome ??= result;
      killTree(child);
    };
    const timer = setTimeout(() => abort(failure('network_error', 'bridge_timeout')), timeoutMs);
    timer.unref?.();
    child.on('error', error => finish(failure('unavailable', error?.code === 'ENOENT' ? 'python_unavailable' : 'bridge_spawn_failed')));
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) abort(failure('error', 'bridge_response_too_large'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', () => {});
    // Orphaned group members (e.g. a browser) would hold the pipes open and delay 'close'.
    child.on('exit', () => killTree(child));
    child.stdin.on('error', () => {});
    child.on('close', code => {
      if (outcome) return finish(outcome);
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        return finish(failure('error', 'malformed_bridge_response'));
      }
      const lines = text.split('\n').filter(line => line.trim());
      if (lines.length !== 1) {
        return finish(failure('error', code === 0 ? 'malformed_bridge_response' : 'bridge_process_failed'));
      }
      let parsed;
      try {
        parsed = JSON.parse(lines[0]);
      } catch {
        return finish(failure('error', 'malformed_bridge_response'));
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !STATUSES.has(parsed.status)) {
        return finish(failure('error', 'malformed_bridge_response'));
      }
      finish(parsed);
    });
    child.stdin.end(input);
  });
}
