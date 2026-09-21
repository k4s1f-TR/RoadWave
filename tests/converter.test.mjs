import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { safeName, outputBase, settingsFrom } from '../lib/audio.mjs';

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
  const res = await fetch(`${url}/api/${endpoint}`, { method: 'POST', headers: { 'X-Roadwave-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await res.json(); assert.equal(res.status, 200, JSON.stringify(result)); return result;
}
async function upload(file, name) {
  const res = await fetch(`${url}/api/upload?name=${encodeURIComponent(name || path.basename(file))}`, { method: 'POST', headers: { 'X-Roadwave-Token': token }, body: await fs.readFile(file) });
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

test('Windows dosya adları ve ayar doğrulama', () => {
  assert.equal(safeName('../../CON.m4a'), '_CON');
  assert.equal(safeName('C:\\music\\a:b?.m4a'), 'a_b_');
  assert.equal(outputBase('Şarkı İÇİN Özgür.m4a', true), 'Sarki ICIN Ozgur');
  assert.throws(() => settingsFrom({ bitrate: 999 }));
});

test('Gerçek FFmpeg ile uçtan uca dönüştürme', { timeout: 120000 }, async t => {
  await fs.mkdir(artifacts, { recursive: true });
  const source = path.join(artifacts, 'Şarkı örneği.m4a');
  const cover = path.join(artifacts, 'cover.jpg');
  const covered = path.join(artifacts, 'covered.flac');
  const coveredM4a = path.join(artifacts, 'covered-m4a.m4a');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', '-metadata', 'title=Yol Şarkısı', '-metadata', 'artist=Roadwave Test', source]);
  ff(['-f', 'lavfi', '-i', 'color=c=0x80cfac:s=900x700', '-frames:v', '1', cover]);
  ff(['-i', source, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'copy', '-disposition:v', 'attached_pic', covered]);
  ff(['-i', source, '-i', cover, '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v', 'attached_pic', coveredM4a]);
  server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: '47832', ROADWAVE_DATA: path.join(artifacts, 'data'), ROADWAVE_OUTPUT: path.join(artifacts, 'output') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; server.stderr.on('data', b => logs += b);
  t.after(async () => { server.kill(); await pause(300); });
  for (let n = 0; n < 50; n++) { try { token = (await state()).token; break; } catch { await pause(100); } }
  assert.ok(token, logs || 'Server failed to start');

  await t.test('API yalnızca yerel yetkili isteklere açık', async () => {
    assert.equal((await fetch(`${url}/api/start`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${url}/api/start`, { method: 'POST', headers: { 'X-Roadwave-Token': token, Origin: 'https://evil.example' } })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      http.get(`${url}/api/state`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(hostStatus, 403);
    const response = await fetch(`${url}/api/upload?name=bad.m4a`, { method: 'POST', headers: { 'X-Roadwave-Token': token }, body: 'not audio' });
    assert.equal(response.status, 400);
    assert.equal((await state()).jobs.length, 0);
  });
  let first;
  await t.test('M4A → MP3, CBR 192, 44.1 kHz, stereo, Türkçe etiketler', async () => {
    const job = await upload(source);
    assert.equal(job.hasCover, false);
    await post('start'); first = await finish(job.id);
    assert.equal(first.status, 'done', first.error);
    const result = probe(first.output);
    const audio = result.streams.find(s => s.codec_type === 'audio');
    assert.equal(audio.codec_name, 'mp3'); assert.equal(audio.sample_rate, '44100'); assert.equal(audio.channels, 2); assert.equal(audio.bit_rate, '192000');
    assert.equal(result.format.tags.title, 'Yol Şarkısı'); assert.equal(result.format.tags.artist, 'Roadwave Test');
    const bytes = await fs.readFile(first.output); assert.equal(bytes.toString('ascii', 0, 3), 'ID3'); assert.equal(bytes[3], 3);
    assert.ok((await fs.stat(source)).size > 0, 'Source preserved');
    assert.equal((await fetch(`${url}/api/audio/${job.id}`, { headers: { Range: 'bytes=0-9' } })).status, 206);
    const range = await fetch(`${url}/api/audio/${job.id}`, { headers: { Range: 'bytes=0-9' } }); assert.equal((await range.arrayBuffer()).byteLength, 10);
    assert.equal((await fetch(`${url}/api/audio/${job.id}?download`)).headers.get('content-type'), 'audio/mpeg');
  });
  await t.test('Gömülü kapak JPEG olarak küçültülür ve korunur', async () => {
    for (const file of [covered, coveredM4a]) {
      const job = await upload(file); assert.equal(job.hasCover, true);
      await post('start'); const done = await finish(job.id); assert.equal(done.status, 'done', done.error);
      const image = probe(done.output).streams.find(s => s.disposition?.attached_pic === 1);
      assert.ok(image); assert.equal(image.codec_name, 'mjpeg'); assert.ok(image.width <= 600 && image.height <= 600);
      assert.ok(Number(probe(done.output).format.duration) >= 3, 'Full audio retained with attached cover');
    }
  });
  await t.test('Kapak kapatma, kalite değiştirme ve isim çakışması', async () => {
    await post('settings', { bitrate: 320, cover: false, ascii: true, parallel: 2 });
    const job = await upload(covered, 'Şarkı örneği.flac'); await post('start');
    const done = await finish(job.id); assert.equal(done.status, 'done', done.error);
    const result = probe(done.output); assert.equal(result.streams.length, 1); assert.equal(result.streams[0].bit_rate, '320000');
    assert.equal(path.basename(done.output), 'Sarki ornegi.mp3');
    const second = await upload(source); await post('settings', { bitrate: 192, cover: true, ascii: false }); await post('start');
    const again = await finish(second.id); assert.equal(again.status, 'done'); assert.notEqual(again.output, first.output);
    assert.match(again.output, /\(2\)\.mp3$/);
  });
  await t.test('Kuyruk iptali ve yeniden deneme', async () => {
    await post('settings', { bitrate: 192, parallel: 1 });
    const one = await upload(source, 'cancel-1.m4a'); const two = await upload(source, 'cancel-2.m4a');
    await post('start'); await post('cancel', { id: two.id });
    const canceled = (await state()).jobs.find(j => j.id === two.id); assert.equal(canceled.status, 'canceled');
    await finish(one.id); await post('start', { id: two.id }); assert.equal((await finish(two.id)).status, 'done');
  });
  await t.test('Liste temizliği çıktı dosyalarını korur', async () => {
    await post('remove', { completed: true }); assert.equal((await state()).jobs.length, 0);
    assert.ok((await fs.stat(first.output)).size > 0);
  });
  await fs.writeFile(path.join(artifacts, 'test-summary.txt'), 'Real FFmpeg integration checks passed.\n');
});
