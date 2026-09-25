import { spawn } from 'node:child_process';
import { processSpawnOptions } from './platform.mjs';

export function terminateProcessTree(child, {
  platform = process.platform,
  spawnImpl = spawn,
  killImpl = process.kill,
  forceAfterMs = 2000
} = {}) {
  if (!child?.pid) return;
  if (platform === 'win32') {
    const killer = spawnImpl('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    killer.once('close', code => { if (code !== 0) child.kill(); });
    return;
  }
  try { killImpl(-child.pid, 'SIGTERM'); }
  catch { child.kill('SIGTERM'); }
  const force = setTimeout(() => {
    try { killImpl(-child.pid, 'SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch {} }
  }, forceAfterMs);
  force.unref();
  child.once('close', () => clearTimeout(force));
}

export function runProcess(command, args, { signal, onLine, timeout = 0, maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Operation stopped.'));
    const child = spawn(command, args, processSpawnOptions());
    let out = '', err = '', buffer = '', failure, received = 0, killing = false;
    const stop = () => {
      failure ||= new Error('Operation stopped.');
      if (killing) return;
      killing = true;
      terminateProcessTree(child);
    };
    const timer = timeout ? setTimeout(() => { failure = new Error('Operation timed out. Check your connection and try again.'); stop(); }, timeout) : null;
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      received += Buffer.byteLength(chunk);
      if (!onLine && received > maxBytes) { failure = new Error('Link info is too large to process. Try a smaller playlist.'); stop(); return; }
      if (onLine) {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/); buffer = lines.pop();
        for (const line of lines) { try { onLine(line); } catch (error) { failure = error; stop(); } }
      } else out += chunk;
    });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-16000); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      if (buffer && onLine && !failure) { try { onLine(buffer); } catch (error) { failure = error; } }
      if (failure || code !== 0) reject(failure || new Error(err || `Engine error code: ${code}`));
      else resolve({ stdout: out, stderr: err });
    });
  });
}
