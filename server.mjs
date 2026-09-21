import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { promises as fsp, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { extensions, settingsFrom, conversionArgs, outputBase } from './lib/audio.mjs';
import { YouTubeManager } from './lib/youtube.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.ROADWAVE_DATA || path.join(ROOT, 'data'));
const INPUTS = path.join(DATA, 'inputs');
const DEFAULT_OUTPUT = path.resolve(process.env.ROADWAVE_OUTPUT || path.join(ROOT, 'outputs'));
const FFMPEG = process.env.FFMPEG_PATH || path.join(ROOT, 'tools/ffmpeg/ffmpeg.exe');
const FFPROBE = process.env.FFPROBE_PATH || path.join(ROOT, 'tools/ffmpeg/ffprobe.exe');
const PORT = Number(process.env.PORT || 47831);
const TOKEN = randomBytes(32).toString('hex');
const clients = new Set();
const processes = new Map();
const active = new Set();
let pickerBusy = false;
let uploadsActive = 0;
let stopping = false;
let settings = { bitrate: 192, cover: true, ascii: false, outputDir: DEFAULT_OUTPUT, parallel: 2 };
let jobs = [];
for (const dir of [DATA, INPUTS, DEFAULT_OUTPUT]) fs.mkdirSync(dir, { recursive: true });
const stateFile = path.join(DATA, 'state.json');
try {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  settings = { ...settings, ...state.settings };
  jobs = state.jobs || [];
  for (const job of jobs) {
    if (['converting', 'queued', 'analyzing'].includes(job.status)) {
      job.status = 'error'; job.error = 'Önceki oturum kesildi. Yeniden deneyebilirsiniz.';
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') console.warn('Oturum kaydı okunamadı; yeni oturum açıldı.');
}

const youtube = new YouTubeManager({ root: ROOT, data: DATA, ffmpeg: FFMPEG, ffprobe: FFPROBE, onChange: () => broadcast(false) });

function persist() {
  try {
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify({ settings, jobs }));
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  } catch (error) { console.error('Oturum kaydedilemedi:', error.message); }
}
function publicJob(job) {
  const { input, info, options, ...rest } = job;
  return rest;
}
function snapshot() {
  return { jobs: jobs.map(publicJob), settings, engineReady: fs.existsSync(FFMPEG) && fs.existsSync(FFPROBE), version: '1.1.0', active: active.size, youtube: youtube.snapshot() };
}
function broadcast(save = true) {
  if (save) persist();
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(data);
}
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1024 * 1024) throw new Error('İstek çok büyük.');
  }
  return data ? JSON.parse(data) : {};
}
function run(executable, args, job, onProgress, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timeout = timeoutMs ? setTimeout(() => { child.kill(); reject(new Error('Dosya bilgileri zamanında okunamadı.')); }, timeoutMs) : null;
    if (job) processes.set(job.id, child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => {
      if (onProgress) onProgress(chunk.toString());
      else stdout = (stdout + chunk).slice(-4 * 1024 * 1024);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (job && processes.get(job.id) === child) processes.delete(job.id);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || 'Dönüştürme motoru çalıştırılamadı.'));
    });
  });
}
function readableError(error) {
  const message = error.message || '';
  if (/ENOSPC|No space left/i.test(message)) return 'Diskte yeterli boş alan yok. Yer açıp yeniden deneyin.';
  if (/EACCES|EPERM|Permission denied/i.test(message)) return 'Klasöre yazılamıyor. Erişilebilir başka bir çıktı klasörü seçin.';
  if (/ENOENT|No such file/i.test(message)) return 'Gerekli dosya veya klasör bulunamadı. Çıktı sürücüsünün bağlı olduğunu kontrol edin.';
  if (/Invalid data|moov atom|could not find|does not contain|Error while decoding|Invalid input/i.test(message)) return 'Dosya okunamadı. Bozuk, desteklenmeyen veya korumalı bir dosya olabilir.';
  return 'Dosya işlenemedi. Dosyanın oynatılabildiğini ve çıktı klasörünün erişilebilir olduğunu kontrol edin.';
}
async function publishOutput(temp, dir, base) {
  await fsp.mkdir(dir, { recursive: true });
  for (let i = 0; ; i++) {
    const target = path.join(dir, `${base}${i ? ` (${i + 1})` : ''}.mp3`);
    try {
      await fsp.copyFile(temp, target, constants.COPYFILE_EXCL);
      return target;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
async function convert(job) {
  active.add(job.id);
  job.status = 'converting'; job.progress = 0; job.error = ''; job.warning = '';
  broadcast();
  const temp = path.join(INPUTS, `${job.id}.part.mp3`);
  try {
    let buffer = '', last = 0;
    const progress = chunk => {
      buffer += chunk;
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        const match = /^out_time_ms=(\d+)/.exec(line);
        if (match && job.duration > 0) job.progress = Math.min(99, Math.round(Number(match[1]) / 1000000 / job.duration * 100));
      }
      if (Date.now() - last > 250) { broadcast(false); last = Date.now(); }
    };
    const encode = async withCover => {
      await run(FFMPEG, conversionArgs(job.input, temp, job.info, job.options, withCover), job, progress);
      if (job.status === 'canceled') throw new Error('Canceled');
      const result = JSON.parse(await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,sample_rate,channels', '-of', 'json', temp], job, null, 60000));
      if (!result.streams?.some(s => s.codec_name === 'mp3' && s.codec_type === 'audio')) throw new Error('Invalid output audio');
    };
    try { await encode(true); }
    catch (error) {
      if (job.status === 'canceled' || !job.hasCover || !job.options.cover) throw error;
      // A malformed cover should not prevent the music from being converted.
      job.warning = 'Kaynak kapak işlenemedi; ses kapaksız dönüştürüldü.';
      await encode(false);
    }
    if (job.status === 'canceled') return;
    job.output = await publishOutput(temp, job.options.outputDir, outputBase(job.name, job.options.ascii));
    job.outputSize = (await fsp.stat(job.output)).size;
    job.status = 'done'; job.progress = 100; job.completedAt = new Date().toISOString();
    job.bitrate = job.options.bitrate;
    await fsp.rm(job.input, { force: true }).catch(() => {});
  } catch (error) {
    if (job.status !== 'canceled') { job.status = 'error'; job.error = readableError(error); }
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {});
    active.delete(job.id);
    broadcast(); pump();
  }
}
function pump() {
  if (stopping) return;
  const limit = Math.min(settings.parallel, Math.max(1, os.availableParallelism()));
  for (const job of jobs) {
    if (active.size >= limit) break;
    if (job.status === 'queued') void convert(job);
  }
}
async function upload(req, res, url) {
  if (!fs.existsSync(FFPROBE)) return json(res, { error: 'FFprobe bulunamadı. Başlat dosyasıyla kurulumu tamamlayın.' }, 503);
  const name = path.win32.basename(url.searchParams.get('name') || '');
  if (!extensions.has(path.extname(name).toLowerCase())) return json(res, { error: 'Bu dosya uzantısı desteklenmiyor.' }, 400);
  const id = randomUUID();
  const input = path.join(INPUTS, `${id}${path.extname(name).toLowerCase()}`);
  const temp = `${input}.upload`;
  uploadsActive++;
  try {
    await pipeline(req, fs.createWriteStream(temp, { flags: 'wx' }));
    const size = (await fsp.stat(temp)).size;
    if (!size) throw new Error('Invalid data');
    await fsp.rename(temp, input);
    const info = JSON.parse(await run(FFPROBE, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', input], null, null, 60000));
    if (!info.streams?.some(s => s.codec_type === 'audio')) throw new Error('File does not contain audio');
    const audio = info.streams.find(s => s.codec_type === 'audio');
    const tags = { ...info.format?.tags, ...audio.tags };
    const job = { id, name, input, info, size, duration: Number(info.format?.duration || audio.duration) || 0,
      title: tags.title || tags.TITLE || '', artist: tags.artist || tags.ARTIST || '',
      hasCover: info.streams.some(s => s.codec_type === 'video' && s.disposition?.attached_pic === 1),
      status: 'ready', progress: 0, createdAt: new Date().toISOString() };
    jobs.push(job); broadcast(); json(res, publicJob(job), 201);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    await fsp.rm(input, { force: true }).catch(() => {});
    if (!res.destroyed) json(res, { error: readableError(error) }, 400);
  } finally {
    uploadsActive--;
  }
}

const staticFiles = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/youtube.css': ['youtube.css', 'text/css'], '/youtube.js': ['youtube.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
  const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!allowedHosts.includes(req.headers.host)) return json(res, { error: 'Geçersiz bağlantı.' }, 403);
  if (req.headers.origin && !allowedHosts.some(h => req.headers.origin === `http://${h}`)) return json(res, { error: 'Yalnızca yerel arayüzden erişilebilir.' }, 403);
  if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, { error: 'Harici erişime kapalı.' }, 403);
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method !== 'GET' && req.headers['x-roadwave-token'] !== TOKEN) return json(res, { error: 'Oturum yenilenmeli. Sayfayı yenileyin.' }, 403);
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, { ...snapshot(), token: TOKEN });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`); clients.add(res);
      req.on('close', () => clients.delete(res)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') return await upload(req, res, url);
    if (req.method === 'POST' && url.pathname.startsWith('/api/youtube/')) {
      const value = await body(req);
      const action = url.pathname.slice('/api/youtube/'.length);
      if (action === 'inspect') return json(res, await youtube.inspect(value));
      if (action === 'enqueue') return json(res, youtube.enqueue(value, settings));
      if (action === 'cancel-inspect') { youtube.cancelInspection(); return json(res, { ok: true }); }
      if (action === 'cancel') { youtube.cancel(value.id); return json(res, { ok: true }); }
      if (action === 'retry') { youtube.retry(value.id); return json(res, { ok: true }); }
      if (action === 'remove') { await youtube.remove(value); return json(res, { ok: true }); }
      if (action === 'update') return json(res, await youtube.update());
      return json(res, { error: 'İşlem bulunamadı.' }, 404);
    }
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      if (active.size || uploadsActive || pickerBusy || youtube.busy) return json(res, { error: 'Önce devam eden işlemleri tamamlayın veya durdurun; açık klasör seçme penceresini kapatın.' }, 409);
      json(res, { ok: true }); setTimeout(shutdown, 100); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const value = await body(req);
      const next = settingsFrom(value);
      const parallel = Number(value.parallel ?? settings.parallel);
      if (![1, 2, 4].includes(parallel)) throw new Error('Geçersiz paralel işlem sayısı.');
      settings = { ...settings, ...next, parallel }; broadcast(); return json(res, settings);
    }
    if (req.method === 'POST' && url.pathname === '/api/start') {
      if (!fs.existsSync(FFMPEG)) throw new Error('FFmpeg bulunamadı. Kurulumu tamamlayın.');
      const value = await body(req);
      const targets = value.id ? jobs.filter(j => j.id === value.id) : jobs.filter(j => j.status === 'ready');
      for (const job of targets) if (['ready', 'error', 'canceled'].includes(job.status) && !active.has(job.id)) {
        if (!fs.existsSync(job.input)) { job.status = 'error'; job.error = 'Kaynak kopya bulunamadı. Dosyayı yeniden ekleyin.'; continue; }
        job.options = { ...settings }; job.status = 'queued'; job.error = ''; job.progress = 0;
      }
      broadcast(); pump(); return json(res, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      const { id } = await body(req);
      for (const job of jobs) if ((!id || job.id === id) && ['queued', 'converting'].includes(job.status)) {
        job.status = 'canceled'; processes.get(job.id)?.kill();
      }
      broadcast(); return json(res, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/remove') {
      const { id, completed } = await body(req);
      const targets = jobs.filter(j => (completed ? j.status === 'done' : j.id === id) && !active.has(j.id) && j.status !== 'queued');
      for (const job of targets) await fsp.rm(job.input, { force: true });
      const ids = new Set(targets.map(j => j.id)); jobs = jobs.filter(j => !ids.has(j.id));
      broadcast(); return json(res, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/folder') {
      if (pickerBusy) return json(res, { error: 'Klasör seçme penceresi zaten açık.' }, 409);
      pickerBusy = true;
      try {
        const selected = (await run('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts/select-folder.ps1')])).trim();
        if (selected) { await fsp.access(selected, constants.W_OK); settings.outputDir = selected; broadcast(); }
        return json(res, { outputDir: settings.outputDir });
      } finally { pickerBusy = false; }
    }
    if (req.method === 'POST' && url.pathname === '/api/open-folder') {
      const { id } = await body(req);
      const job = [...jobs, ...youtube.jobs].find(j => j.id === id);
      const dir = job?.output ? path.dirname(job.output) : settings.outputDir;
      await fsp.mkdir(dir, { recursive: true });
      const child = spawn('explorer.exe', [dir], { windowsHide: true, detached: true, stdio: 'ignore' });
      child.on('error', () => {}); child.unref(); return json(res, { ok: true });
    }
    const match = /^\/api\/audio\/([a-f0-9-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && match) {
      const job = [...jobs, ...youtube.jobs].find(j => j.id === match[1] && j.status === 'done');
      if (!job) return json(res, { error: 'Dosya bulunamadı.' }, 404);
      let stat; try { stat = await fsp.stat(job.output); } catch { return json(res, { error: 'Çıktı taşınmış veya silinmiş.' }, 404); }
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
      const headers = { 'Content-Type': job.format === 'mp4' ? 'video/mp4' : 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      if (url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(job.output)).replace(/'/g, '%27')}`;
      res.writeHead(range ? 206 : 200, headers);
      await pipeline(fs.createReadStream(job.output, { start, end }), res); return;
    }
    if (req.method === 'GET' && staticFiles[url.pathname]) {
      const [file, type] = staticFiles[url.pathname];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      return res.end(await fsp.readFile(path.join(ROOT, 'public', file)));
    }
    json(res, { error: 'Bulunamadı.' }, 404);
  } catch (error) {
    if (!res.headersSent) json(res, { error: error.message.length < 180 ? error.message : readableError(error) }, 400);
    else res.end();
  }
});
server.requestTimeout = 0;
const heartbeat = setInterval(() => { for (const res of clients) res.write(': heartbeat\n\n'); }, 20000);
heartbeat.unref();
function openBrowser() {
  const child = spawn('explorer.exe', [`http://127.0.0.1:${PORT}`], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {}); child.unref();
}
server.on('error', async error => {
  if (error.code === 'EADDRINUSE') {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/state`);
      const data = await response.json();
      if (data.version && data.settings && data.token) {
        console.log(`Roadwave zaten açık: http://127.0.0.1:${PORT}`);
        if (process.argv.includes('--open')) openBrowser();
        process.exit(0);
      }
    } catch {}
  }
  console.error(`Başlatılamadı: ${error.message}`); process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  // Cleanup only after acquiring the port, so a second launcher cannot touch an active conversion.
  for (const name of fs.readdirSync(INPUTS)) {
    if (name.endsWith('.part.mp3') || name.endsWith('.upload')) fs.rmSync(path.join(INPUTS, name), { force: true });
  }
  console.log(`Roadwave hazır: http://127.0.0.1:${PORT}`);
  if (process.argv.includes('--open')) openBrowser();
});
function shutdown() {
  stopping = true;
  youtube.shutdown();
  for (const child of processes.values()) child.kill();
  persist(); server.close();
  for (const client of clients) client.end();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
