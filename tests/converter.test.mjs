import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { safeName, outputBase, settingsFrom, extensions } from '../lib/audio.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'test-artifacts', `run-${Date.now()}`);
const ffmpeg = path.join(root, 'tools/ffmpeg/ffmpeg.exe');
const ffprobe = path.join(root, 'tools/ffmpeg/ffprobe.exe');
const url = 'http://127.0.0.1:47832';
let server, token;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ff = args => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, timeout: 30000 });
const probe = file => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { windowsHide: true, encoding: 'utf8' }));
async function state() { return (await fetch(`${url}/api/state`)).json(); }
async function post(endpoint, data = {}) {
  const res = await fetch(`${url}/api/${endpoint}`, { method: 'POST', headers: { 'X-Soundwave-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await res.json(); assert.equal(res.status, 200, JSON.stringify(result)); return result;
}
async function upload(file, name) {
  const res = await fetch(`${url}/api/upload?name=${encodeURIComponent(name || path.basename(file))}`, { method: 'POST', headers: { 'X-Soundwave-Token': token }, body: await fs.readFile(file) });
  assert.equal(res.status, 201, await res.clone().text()); return res.json();
}
async function finish(id) {
  for (let n = 0; n < 200; n++) {
    const job = (await state()).jobs.find(j => j.id === id);
    if (['done', 'error', 'canceled'].includes(job.status)) return job;
    await pause(100);
  }
  throw new Error('Conversion timeout');
}

test('Windows filenames and settings validation', () => {
  assert.equal(safeName('../../CON.m4a'), '_CON');
  assert.equal(safeName('C:\\music\\a:b?.m4a'), 'a_b_');
  assert.equal(outputBase('Şarkı İÇİN Özgür.m4a', true), 'Sarki ICIN Ozgur');
  assert.throws(() => settingsFrom({ bitrate: 999 }));
  assert.equal(settingsFrom({ format: 'aac', quality: 96 }).quality, 96);
  assert.equal(settingsFrom({ format: 'wav', quality: 24 }).quality, 24);
  assert.equal(settingsFrom({ format: 'flac', bitrate: 192 }, { migrateLegacy: true }).quality, 5);
  assert.throws(() => settingsFrom({ format: 'aac', quality: 320 }));
  for (const extension of ['.mov', '.mkv', '.mka']) assert.equal(extensions.has(extension), true);
});

test('End-to-end conversion with real FFmpeg', { timeout: 120000 }, async t => {
  await fs.mkdir(artifacts, { recursive: true });
  const source = path.join(artifacts, 'Şarkı örneği.m4a');
  const cover = path.join(artifacts, 'cover.jpg');
  const covered = path.join(artifacts, 'covered.flac');
  const coveredM4a = path.join(artifacts, 'covered-m4a.m4a');
  const dataDir = path.join(artifacts, 'data'), outputDir = path.join(artifacts, 'output');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', '-metadata', 'title=Test Song', '-metadata', 'artist=Soundwave Test', source]);
  ff(['-f', 'lavfi', '-i', 'color=c=0x80cfac:s=900x700', '-frames:v', '1', cover]);
  ff(['-i', source, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'copy', '-disposition:v', 'attached_pic', covered]);
  ff(['-i', source, '-i', cover, '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v', 'attached_pic', coveredM4a]);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ settings: { bitrate: 192, cover: true, ascii: false, format: 'mp3', outputDir, parallel: 2 }, jobs: { malformed: true } }));
  server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: '47832', SOUNDWAVE_DATA: dataDir, SOUNDWAVE_OUTPUT: outputDir, SOUNDWAVE_MAX_UPLOAD_BYTES: '2097152' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; server.stderr.on('data', b => logs += b);
  t.after(async () => { server.kill(); await pause(300); });
  for (let n = 0; n < 50; n++) { try { token = (await state()).token; break; } catch { await pause(100); } }
  assert.ok(token, logs || 'Server failed to start');

  await t.test('API is restricted to local authorized requests', async () => {
    const securedState = await fetch(`${url}/api/state`);
    assert.equal(securedState.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(securedState.headers.get('permissions-policy'), /microphone=\(\)/);
    assert.equal((await fetch(`${url}/api/start`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${url}/api/start`, { method: 'POST', headers: { 'X-Soundwave-Token': token, Origin: 'https://evil.example' } })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      http.get(`${url}/api/state`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(hostStatus, 403);
    const oversizeStatus = await new Promise((resolve, reject) => {
      const request = http.request(`${url}/api/upload?name=large.m4a`, { method: 'POST', agent: false, headers: { 'X-Soundwave-Token': token, 'Content-Length': 2097153, Connection: 'close' } }, response => {
        response.resume(); resolve(response.statusCode);
      });
      request.on('error', reject); request.end();
    });
    assert.equal(oversizeStatus, 413);
    const streamedOversize = await new Promise((resolve, reject) => {
      let settled = false;
      const request = http.request(`${url}/api/upload?name=streamed-large.m4a`, { method: 'POST', agent: false, headers: { 'X-Soundwave-Token': token, Connection: 'close' } }, response => {
        settled = true; let responseBody = '';
        response.on('data', chunk => responseBody += chunk);
        response.on('end', () => resolve({ status: response.statusCode, body: responseBody }));
      });
      request.on('error', error => { if (!settled) reject(error); });
      request.write(Buffer.alloc(1024 * 1024));
      request.write(Buffer.alloc(1024 * 1024));
      request.end(Buffer.alloc(1));
    });
    assert.equal(streamedOversize.status, 413, JSON.stringify(streamedOversize));
    const response = await fetch(`${url}/api/upload?name=bad.m4a`, { method: 'POST', headers: { 'X-Soundwave-Token': token }, body: 'not audio' });
    assert.equal(response.status, 400);
    assert.equal((await state()).jobs.length, 0);
  });
  let first;
  await t.test('M4A → MP3, CBR 192, 44.1 kHz, stereo, metadata tags', async () => {
    const job = await upload(source);
    assert.equal(job.hasCover, false);
    await post('start'); first = await finish(job.id);
    assert.equal(first.status, 'done', first.error);
    const result = probe(first.output);
    const audio = result.streams.find(s => s.codec_type === 'audio');
    assert.equal(audio.codec_name, 'mp3'); assert.equal(audio.sample_rate, '44100'); assert.equal(audio.channels, 2); assert.equal(audio.bit_rate, '192000');
    assert.equal(result.format.tags.title, 'Test Song'); assert.equal(result.format.tags.artist, 'Soundwave Test');
    const bytes = await fs.readFile(first.output); assert.equal(bytes.toString('ascii', 0, 3), 'ID3'); assert.equal(bytes[3], 3);
    assert.ok((await fs.stat(source)).size > 0, 'Source preserved');
    assert.equal((await fetch(`${url}/api/audio/${job.id}`, { headers: { Range: 'bytes=0-9' } })).status, 206);
    const range = await fetch(`${url}/api/audio/${job.id}`, { headers: { Range: 'bytes=0-9' } }); assert.equal((await range.arrayBuffer()).byteLength, 10);
    assert.equal((await fetch(`${url}/api/audio/${job.id}?download`)).headers.get('content-type'), 'audio/mpeg');
  });
  await t.test('Format-specific quality produces M4A, FLAC, WAV, Opus and OGG', async () => {
    const cases = [
      { format: 'aac', quality: 128, codec: 'aac', extension: '.m4a' },
      { format: 'flac', quality: 8, codec: 'flac', extension: '.flac' },
      { format: 'wav', quality: 24, codec: 'pcm_s24le', extension: '.wav' },
      { format: 'opus', quality: 128, codec: 'opus', extension: '.opus' },
      { format: 'ogg', quality: 6, codec: 'vorbis', extension: '.ogg' }
    ];
    for (const item of cases) {
      await post('settings', { format: item.format, quality: item.quality, cover: false, ascii: false, parallel: 1 });
      const job = await upload(source, `format-${item.format}.m4a`);
      await post('start', { id: job.id });
      const done = await finish(job.id); assert.equal(done.status, 'done', done.error);
      assert.equal(path.extname(done.output), item.extension);
      assert.equal(probe(done.output).streams.find(stream => stream.codec_type === 'audio').codec_name, item.codec);
      assert.equal(done.quality, item.quality);
    }
  });
  await t.test('Embedded cover is scaled as JPEG and preserved', async () => {
    await post('settings', { format: 'mp3', quality: 192, cover: true, ascii: false, parallel: 2 });
    for (const file of [covered, coveredM4a]) {
      const job = await upload(file); assert.equal(job.hasCover, true);
      await post('start'); const done = await finish(job.id); assert.equal(done.status, 'done', done.error);
      const image = probe(done.output).streams.find(s => s.disposition?.attached_pic === 1);
      assert.ok(image); assert.equal(image.codec_name, 'mjpeg'); assert.ok(image.width <= 600 && image.height <= 600);
      assert.ok(Number(probe(done.output).format.duration) >= 3, 'Full audio retained with attached cover');
    }
  });
  await t.test('Disable cover, change quality and name collision', async () => {
    await post('settings', { bitrate: 320, cover: false, ascii: true, parallel: 2 });
    const job = await upload(covered, 'Şarkı örneği.flac'); await post('start');
    const done = await finish(job.id); assert.equal(done.status, 'done', done.error);
    const result = probe(done.output); assert.equal(result.streams.length, 1); assert.equal(result.streams[0].bit_rate, '320000');
    assert.equal(path.basename(done.output), 'Sarki ornegi.mp3');
    const second = await upload(source); await post('settings', { bitrate: 192, cover: true, ascii: false }); await post('start');
    const again = await finish(second.id); assert.equal(again.status, 'done'); assert.notEqual(again.output, first.output);
    assert.match(again.output, /\(2\)\.mp3$/);
  });
  await t.test('Queue cancellation and retry', async () => {
    await post('settings', { bitrate: 192, parallel: 1 });
    const one = await upload(source, 'cancel-1.m4a'); const two = await upload(source, 'cancel-2.m4a');
    await post('start'); await post('cancel', { id: two.id });
    const canceled = (await state()).jobs.find(j => j.id === two.id); assert.equal(canceled.status, 'canceled');
    await finish(one.id); await post('start', { id: two.id }); assert.equal((await finish(two.id)).status, 'done');
  });
  await t.test('List cleanup preserves output files', async () => {
    await post('remove', { completed: true }); assert.equal((await state()).jobs.length, 0);
    assert.ok((await fs.stat(first.output)).size > 0);
  });
  await fs.writeFile(path.join(artifacts, 'test-summary.txt'), 'Real FFmpeg integration checks passed.\n');
});
