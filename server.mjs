import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { promises as fsp, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { extensions, settingsFrom, conversionArgs, outputBase, getFormatInfo } from './lib/audio.mjs';
import { YouTubeManager } from './lib/youtube.mjs';
import { terminateProcessTree } from './lib/process.mjs';
import { executableAvailable, ffmpegEncoderAvailable, folderPickerCommand, openerCommand, processSpawnOptions, resolveToolchain, safeUploadBasename } from './lib/platform.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.SOUNDWAVE_DATA || path.join(ROOT, 'data'));
const INPUTS = path.join(DATA, 'inputs');
const DEFAULT_OUTPUT = path.resolve(process.env.SOUNDWAVE_OUTPUT || path.join(ROOT, 'outputs'));
const tools = resolveToolchain(ROOT);
const FFMPEG = tools.ffmpeg;
const FFPROBE = tools.ffprobe;
const ENGINE_READY = executableAvailable(FFMPEG) && executableAvailable(FFPROBE);
const VORBIS_ENCODER = ENGINE_READY && ffmpegEncoderAvailable(FFMPEG, 'libvorbis') ? 'libvorbis' : 'vorbis';
const PORT = Number(process.env.PORT || 47831);
const configuredUploadLimit = Number(process.env.SOUNDWAVE_MAX_UPLOAD_BYTES || 4 * 1024 ** 3);
const MAX_UPLOAD_BYTES = Number.isSafeInteger(configuredUploadLimit) && configuredUploadLimit > 0 ? configuredUploadLimit : 4 * 1024 ** 3;
const configuredRequestTimeout = Number(process.env.SOUNDWAVE_REQUEST_TIMEOUT_MS || 30 * 60 * 1000);
const REQUEST_TIMEOUT_MS = Number.isSafeInteger(configuredRequestTimeout) && configuredRequestTimeout >= 30000 ? configuredRequestTimeout : 30 * 60 * 1000;
const TOKEN = randomBytes(32).toString('hex');
const clients = new Set();
const processes = new Map();
const active = new Set();
let pickerBusy = false;
let uploadsActive = 0;
let stopping = false;
let settings = { quality: 192, cover: true, ascii: false, format: 'mp3', outputDir: DEFAULT_OUTPUT, parallel: 2 };
let jobs = [];
for (const dir of [DATA, INPUTS, DEFAULT_OUTPUT]) fs.mkdirSync(dir, { recursive: true });
const stateFile = path.join(DATA, 'state.json');
try {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const saved = state.settings && typeof state.settings === 'object' ? state.settings : {};
  const parallel = [1, 2, 4].includes(Number(saved.parallel)) ? Number(saved.parallel) : settings.parallel;
  const outputDir = typeof saved.outputDir === 'string' && path.isAbsolute(saved.outputDir) ? path.resolve(saved.outputDir) : settings.outputDir;
  settings = { ...settings, ...settingsFrom(saved, { migrateLegacy: true }), parallel, outputDir };
  jobs = Array.isArray(state.jobs) ? state.jobs.filter(job => job && typeof job === 'object' && /^[a-f0-9-]{36}$/.test(job.id || '')) : [];
  for (const job of jobs) {
    if (['converting', 'queued', 'analyzing'].includes(job.status)) {
      job.status = 'error'; job.error = 'Previous session was interrupted. You can try again.';
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') console.warn('Could not read session state; started a new session.');
}

const youtube = new YouTubeManager({ root: ROOT, data: DATA, ffmpeg: FFMPEG, ffprobe: FFPROBE, executable: tools.ytdlp, onChange: () => broadcast(false) });

function persist() {
  try {
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify({ settings, jobs }));
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  } catch (error) { console.error('Could not save session:', error.message); }
}
function publicJob(job) {
  const { input, info, options, ...rest } = job;
  return rest;
}
function snapshot() {
  return { jobs: jobs.map(publicJob), settings, engineReady: ENGINE_READY, version: '1.3.0', platform: process.platform, active: active.size, youtube: youtube.snapshot(), downloader: youtube.snapshot() };
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
    if (data.length > 1024 * 1024) throw new Error('Request too large.');
  }
  return data ? JSON.parse(data) : {};
}
function run(executable, args, job, onProgress, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, processSpawnOptions());
    const timeout = timeoutMs ? setTimeout(() => { terminateProcessTree(child); reject(new Error('File information could not be read in time.')); }, timeoutMs) : null;
    if (job) processes.set(job.id, child);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => {
      if (onProgress) onProgress(chunk.toString());
      else stdout = (stdout + chunk).slice(-4 * 1024 * 1024);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    child.once('error', error => {
      clearTimeout(timeout);
      if (job && processes.get(job.id) === child) processes.delete(job.id);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timeout);
      if (job && processes.get(job.id) === child) processes.delete(job.id);
      if (code === 0) resolve(stdout);
      else {
        const error = new Error(stderr || 'Failed to execute conversion engine.');
        error.exitCode = code;
        reject(error);
      }
    });
  });
}
function readableError(error) {
  const message = error.message || '';
  if (/ENOSPC|No space left/i.test(message)) return 'Disk is full. Free up space and try again.';
  if (/EACCES|EPERM|Permission denied/i.test(message)) return 'Cannot write to folder. Choose an accessible output folder.';
  if (/ENOENT|No such file/i.test(message)) return 'Required file or folder not found. Ensure the output drive is connected.';
  if (/Invalid data|moov atom|could not find|does not contain|Error while decoding|Invalid input/i.test(message)) return 'File could not be read. It may be corrupt, unsupported, or protected.';
  return 'File could not be processed. Ensure the file can be played and the output folder is accessible.';
}
async function saveUpload(req, destination) {
  let received = 0;
  const file = await fsp.open(destination, 'wx');
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        req.resume();
        const error = new Error(`File exceeds the ${Math.ceil(MAX_UPLOAD_BYTES / 1024 ** 2)} MB upload limit.`);
        error.code = 'ETOOBIG'; throw error;
      }
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, null);
        if (!bytesWritten) throw new Error('Could not write uploaded file.');
        offset += bytesWritten;
      }
    }
  } finally {
    await file.close();
  }
}
async function publishOutput(temp, dir, base, ext = '.mp3') {
  await fsp.mkdir(dir, { recursive: true });
  for (let i = 0; ; i++) {
    const target = path.join(dir, `${base}${i ? ` (${i + 1})` : ''}${ext}`);
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
  const formatInfo = getFormatInfo(job.options.format || 'mp3');
  const temp = path.join(INPUTS, `${job.id}.part${formatInfo.ext}`);
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
      await run(FFMPEG, conversionArgs(job.input, temp, job.info, { ...job.options, vorbisEncoder: VORBIS_ENCODER }, withCover), job, progress);
      if (job.status === 'canceled') throw new Error('Canceled');
      const result = JSON.parse(await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,sample_rate,channels', '-of', 'json', temp], job, null, 60000));
      const expectedCodec = formatInfo.id === 'wav' && job.options.quality === 24 ? 'pcm_s24le' : { mp3: 'mp3', wav: 'pcm_s16le', flac: 'flac', ogg: 'vorbis', aac: 'aac', opus: 'opus' }[formatInfo.id];
      if (!result.streams?.some(s => s.codec_name === expectedCodec && s.codec_type === 'audio')) throw new Error('Invalid output audio');
    };
    try { await encode(formatInfo.id === 'mp3'); }
    catch (error) {
      if (job.status === 'canceled' || !job.hasCover || !job.options.cover || formatInfo.id !== 'mp3') throw error;
      // A malformed cover should not prevent the music from being converted.
      job.warning = 'Source cover could not be processed; audio converted without cover.';
      await encode(false);
    }
    if (job.status === 'canceled') return;
    job.output = await publishOutput(temp, job.options.outputDir, outputBase(job.name, job.options.ascii), formatInfo.ext);
    job.outputSize = (await fsp.stat(job.output)).size;
    job.status = 'done'; job.progress = 100; job.completedAt = new Date().toISOString();
    job.quality = job.options.quality;
    job.bitrate = ['mp3', 'aac', 'opus'].includes(formatInfo.id) ? job.options.quality : undefined;
    job.format = formatInfo.id;
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
  if (!ENGINE_READY) return json(res, { error: 'FFmpeg and FFprobe were not found. Run the setup command for your platform, then restart SoundWave.' }, 503);
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    res.setHeader('Connection', 'close');
    res.once('finish', () => req.destroy());
    req.resume();
    return json(res, { error: `File exceeds the ${Math.ceil(MAX_UPLOAD_BYTES / 1024 ** 2)} MB upload limit.` }, 413);
  }
  const name = safeUploadBasename(url.searchParams.get('name') || '');
  if (!extensions.has(path.extname(name).toLowerCase())) return json(res, { error: 'This file extension is not supported.' }, 400);
  const id = randomUUID();
  const input = path.join(INPUTS, `${id}${path.extname(name).toLowerCase()}`);
  const temp = `${input}.upload`;
  uploadsActive++;
  try {
    await saveUpload(req, temp);
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
    const tooLarge = error.code === 'ETOOBIG';
    if (!res.destroyed) json(res, { error: tooLarge ? `File exceeds the ${Math.ceil(MAX_UPLOAD_BYTES / 1024 ** 2)} MB upload limit.` : readableError(error) }, tooLarge ? 413 : 400);
  } finally {
    uploadsActive--;
  }
}

const staticFiles = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/youtube.css': ['youtube.css', 'text/css'], '/youtube.js': ['youtube.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
  const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!allowedHosts.includes(req.headers.host)) return json(res, { error: 'Invalid connection.' }, 403);
  if (req.headers.origin && !allowedHosts.some(h => req.headers.origin === `http://${h}`)) return json(res, { error: 'Only accessible from the local interface.' }, 403);
  if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, { error: 'External access forbidden.' }, 403);
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method !== 'GET' && req.headers['x-soundwave-token'] !== TOKEN) return json(res, { error: 'Session expired. Refresh the page.' }, 403);
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, { ...snapshot(), token: TOKEN });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`); clients.add(res);
      req.on('close', () => clients.delete(res)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') return await upload(req, res, url);
    if (req.method === 'POST' && (url.pathname.startsWith('/api/downloader/') || url.pathname.startsWith('/api/youtube/'))) {
      const value = await body(req);
      const prefix = url.pathname.startsWith('/api/downloader/') ? '/api/downloader/' : '/api/youtube/';
      const action = url.pathname.slice(prefix.length);
      if (action === 'inspect') return json(res, await youtube.inspect(value));
      if (action === 'enqueue') return json(res, youtube.enqueue(value, settings));
      if (action === 'cancel-inspect') { youtube.cancelInspection(); return json(res, { ok: true }); }
      if (action === 'cancel') { youtube.cancel(value.id); return json(res, { ok: true }); }
      if (action === 'retry') { youtube.retry(value.id); return json(res, { ok: true }); }
      if (action === 'remove') { await youtube.remove(value); return json(res, { ok: true }); }
      if (action === 'update') return json(res, await youtube.update());
      return json(res, { error: 'Operation not found.' }, 404);
    }
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      if (active.size || uploadsActive || pickerBusy || youtube.busy) return json(res, { error: 'Complete or stop ongoing operations first; close any open folder picker.' }, 409);
      json(res, { ok: true }); setTimeout(shutdown, 100); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const value = await body(req);
      const next = settingsFrom(value);
      const parallel = Number(value.parallel ?? settings.parallel);
      if (![1, 2, 4].includes(parallel)) throw new Error('Invalid parallel processing count.');
      settings = { ...settings, ...next, parallel }; broadcast(); return json(res, settings);
    }
    if (req.method === 'POST' && url.pathname === '/api/start') {
      if (!ENGINE_READY) throw new Error('FFmpeg not found. Complete setup for your platform and restart SoundWave.');
      const value = await body(req);
      const targets = value.id ? jobs.filter(j => j.id === value.id) : jobs.filter(j => j.status === 'ready');
      for (const job of targets) if (['ready', 'error', 'canceled'].includes(job.status) && !active.has(job.id)) {
        if (!fs.existsSync(job.input)) { job.status = 'error'; job.error = 'Source copy not found. Add the file again.'; continue; }
        job.options = { ...settings }; job.status = 'queued'; job.error = ''; job.progress = 0;
      }
      broadcast(); pump(); return json(res, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      const { id } = await body(req);
      for (const job of jobs) if ((!id || job.id === id) && ['queued', 'converting'].includes(job.status)) {
        job.status = 'canceled'; terminateProcessTree(processes.get(job.id));
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
      if (pickerBusy) return json(res, { error: 'Folder selection dialog is already open.' }, 409);
      pickerBusy = true;
      try {
        const picker = folderPickerCommand(ROOT, { initial: settings.outputDir });
        let selected = '';
        try { selected = (await run(picker.command, picker.args)).trim(); }
        catch (error) { if (!picker.cancelCodes.includes(error.exitCode)) throw error; }
        if (selected) { await fsp.access(selected, constants.W_OK); settings.outputDir = selected; broadcast(); }
        return json(res, { outputDir: settings.outputDir });
      } finally { pickerBusy = false; }
    }
    if (req.method === 'POST' && url.pathname === '/api/open-folder') {
      const { id } = await body(req);
      const job = [...jobs, ...youtube.jobs].find(j => j.id === id);
      const dir = job?.output ? path.dirname(job.output) : settings.outputDir;
      await fsp.mkdir(dir, { recursive: true });
      const opener = openerCommand(dir);
      const child = spawn(opener.command, opener.args, { windowsHide: true, detached: true, stdio: 'ignore' });
      child.on('error', () => {}); child.unref(); return json(res, { ok: true });
    }
    const match = /^\/api\/audio\/([a-f0-9-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && match) {
      const job = [...jobs, ...youtube.jobs].find(j => j.id === match[1] && j.status === 'done');
      if (!job) return json(res, { error: 'File not found.' }, 404);
      let stat; try { stat = await fsp.stat(job.output); } catch { return json(res, { error: 'Output file moved or deleted.' }, 404); }
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
      const mimeTypes = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/mp4', mp4: 'video/mp4' };
      const contentType = mimeTypes[job.format || job.options?.format] || 'audio/mpeg';
      const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
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
    json(res, { error: 'Not found.' }, 404);
  } catch (error) {
    if (!res.headersSent) json(res, { error: error.message.length < 180 ? error.message : readableError(error) }, 400);
    else res.end();
  }
});
server.requestTimeout = REQUEST_TIMEOUT_MS;
const heartbeat = setInterval(() => { for (const res of clients) res.write(': heartbeat\n\n'); }, 20000);
heartbeat.unref();
function openBrowser() {
  try {
    const opener = openerCommand(`http://127.0.0.1:${PORT}`);
    const child = spawn(opener.command, opener.args, { detached: true, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {}); child.unref();
  } catch (error) { console.warn(`${error.message} Open http://127.0.0.1:${PORT} manually.`); }
}
server.on('error', async error => {
  if (error.code === 'EADDRINUSE') {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/state`);
      const data = await response.json();
      if (data.version && data.settings && data.token) {
        console.log(`SoundWave is already running: http://127.0.0.1:${PORT}`);
        if (process.argv.includes('--open')) openBrowser();
        process.exit(0);
      }
    } catch {}
  }
  console.error(`Failed to start: ${error.message}`); process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  // Cleanup only after acquiring the port, so a second launcher cannot touch an active conversion.
  for (const name of fs.readdirSync(INPUTS)) {
    if (name.includes('.part.') || name.endsWith('.upload')) fs.rmSync(path.join(INPUTS, name), { force: true });
  }
  console.log(`SoundWave ready: http://127.0.0.1:${PORT}`);
  if (process.argv.includes('--open')) openBrowser();
});
function shutdown() {
  stopping = true;
  youtube.shutdown();
  for (const child of processes.values()) terminateProcessTree(child);
  persist(); server.close();
  for (const client of clients) client.end();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
