import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { runProcess } from '../lib/process.mjs';

test('Abort terminates child process and leaves no background orphans', { timeout: 10000 }, async () => {
  const dir = path.resolve('test-artifacts', `cancel-process-${Date.now()}`); await fs.mkdir(dir, { recursive: true });
  const marker = path.join(dir, 'should-not-exist.txt');
  const childCode = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),1200);`;
  const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{windowsHide:true,stdio:'ignore'});console.log('ready');setInterval(()=>{},10000);`;
  const controller = new AbortController();
  await assert.rejects(runProcess(process.execPath, ['-e', parentCode], { signal: controller.signal, onLine: () => controller.abort() }), /stopped/i);
  await new Promise(resolve => setTimeout(resolve, 1500));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});
