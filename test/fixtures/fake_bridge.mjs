// Stand-in for python/bridge.py, run with node. Behaviour is selected by args.case.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(raw);
  const { case: name, pidFile } = request.args ?? {};
  const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  switch (name) {
    case 'echo': out({ status: 'ok', echo: request, env: { PYTHONNOUSERSITE: process.env.PYTHONNOUSERSITE } }); break;
    case 'stderr': process.stderr.write('Traceback: jane.doe@example.com\n'); out({ status: 'ok' }); break;
    case 'malformed': process.stdout.write('not json\n'); break;
    case 'two_lines': out({ status: 'ok' }); out({ status: 'ok' }); break;
    case 'array': out([1, 2]); break;
    case 'bad_status': out({ status: 'definitely_fine' }); break;
    case 'invalid_utf8': process.stdout.write(Buffer.from([0x7b, 0xff, 0x7d, 0x0a])); break;
    case 'big': process.stdout.write('x'.repeat(64 * 1024)); break;
    case 'exit1': process.exitCode = 1; break;
    case 'hang': {
      // A grandchild standing in for a browser that must not outlive the request.
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(pidFile, String(grandchild.pid));
      setInterval(() => {}, 1000);
      break;
    }
    case 'orphan': {
      // Exits normally but leaves a grandchild holding stdout open.
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
      writeFileSync(pidFile, String(grandchild.pid));
      out({ status: 'ok' });
      process.exit(0);
      break;
    }
    default: out({ status: 'error', reason: 'unknown_case' });
  }
});
