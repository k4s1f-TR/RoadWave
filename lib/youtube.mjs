import path from 'node:path';
import fs, { promises as fsp, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runProcess } from './process.mjs';
import { conversionArgs, outputBase } from './audio.mjs';

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const LIST_ID = /^[a-zA-Z0-9_-]{10,200}$/;
const runningStates = ['downloading', 'processing', 'saving'];
export function normalizeYouTubeUrl(value, scope = 'video') {
  if (typeof value !== 'string' || value.length > 3000) throw new Error('Geçerli bir YouTube bağlantısı girin.');
  let url;
  try { url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`); } catch { throw new Error('Bağlantı okunamadı.'); }
  const host = url.hostname.toLowerCase();
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'].includes(host) || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('Yalnızca YouTube video veya oynatma listesi bağlantıları destekleniyor.');
  const parts = url.pathname.split('/').filter(Boolean);
  const id = host.endsWith('youtu.be') ? parts[0] : ['shorts', 'live', 'embed'].includes(parts[0]) ? parts[1] : url.pathname === '/watch' ? url.searchParams.get('v') : null;
  const list = url.searchParams.get('list');
  if (list && LIST_ID.test(list) && (scope === 'playlist' || url.pathname === '/playlist')) return { url: `https://www.youtube.com/playlist?list=${list}`, kind: 'playlist' };
  if (id && VIDEO_ID.test(id)) return { url: `https://www.youtube.com/watch?v=${id}`, kind: 'video' };
  throw new Error('Video veya oynatma listesi bağlantısı bulunamadı. Kanal bağlantısı yerine video bağlantısını yapıştırın.');
}
export function downloadOptions(value = {}) {
  const format = value.format || 'mp3';
  const bitrate = Number(value.bitrate ?? 192), resolution = Number(value.resolution ?? 1080);
  if (!['mp3', 'mp4'].includes(format) || ![128, 192, 256, 320].includes(bitrate) || ![360, 480, 720, 1080, 1440, 2160].includes(resolution)) throw new Error('Geçersiz indirme ayarı.');
  return { format, bitrate, resolution, cover: value.cover !== false, ascii: value.ascii === true };
}
export function youtubeError(error) {
  const text = error.message || '';
  if (/SSL|TLS|CERTIFICATE/i.test(text)) return 'Güvenli YouTube bağlantısı kurulamadı (TLS). Ağ bağlantısını kontrol edip yeniden deneyin.';
  if (/sign in|login|cookies|confirm.*bot|authentication/i.test(text)) return 'YouTube bu bağlantı için oturum veya bot doğrulaması istiyor. Bu oturumsuz indiricide şu anda indirilemiyor.';
  if (/private|unavailable|removed|not available|members.only|copyright/i.test(text)) return 'Video özel, kaldırılmış veya bu bağlantıdan erişilemiyor. Listedeki diğer videolar devam eder.';
  if (/HTTP Error 403|HTTP Error 429|rate.limit|Forbidden/i.test(text)) return 'YouTube erişimi geçici olarak sınırladı. Bir süre sonra yeniden deneyin; gerekirse motoru güncelleyin.';
  if (/Unsupported URL/i.test(text)) return 'Bağlantı desteklenmiyor.';
  if (/Requested format|format.*not available/i.test(text)) return 'Bu video için seçilen çözünürlükte uygun akış bulunamadı. Farklı bir kalite deneyin.';
  if (/ENOSPC|No space/i.test(text)) return 'Diskte yeterli boş alan yok.';
  if (/EACCES|EPERM|Permission denied/i.test(text)) return 'Çıktı klasörüne yazılamadı. Farklı bir klasör seçin.';
  if (/Unable to download|resolve|timed out|connection|network/i.test(text)) return 'YouTube bağlantısı kurulamadı. İnterneti kontrol edip yeniden deneyin.';
  if (/ENOENT/i.test(text)) return 'İndirme motoru veya gerekli dosya bulunamadı. Motoru kurun / güncelleyin.';
  if (/zaman aşım|durduruldu|kadar büyük|Ses akışı|Video akışı|Oynatma listesi boş/.test(text)) return text;
  return 'İndirme tamamlanamadı. Bağlantıyı kontrol edin veya YouTube motorunu güncelleyip yeniden deneyin.';
}

export class YouTubeManager {
  constructor({ root, data, ffmpeg, ffprobe, onChange = () => {}, runner = runProcess, executable }) {
    Object.assign(this, { root, ffmpeg, ffprobe, onChange, runner });
    this.executable = executable || process.env.YTDLP_PATH || path.join(root, 'tools/yt-dlp/yt-dlp.exe');
    this.dir = path.join(data, 'youtube'); this.work = path.join(this.dir, 'work');
    fs.mkdirSync(this.work, { recursive: true });
    this.stateFile = path.join(this.dir, 'state.json');
    this.jobs = []; this.active = new Map(); this.inspections = new Map(); this.previews = new Map(); this.updating = false; this.stopping = false;
    try { this.jobs = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')).jobs || []; } catch {}
    for (const job of this.jobs) if (runningStates.includes(job.status) || job.status === 'queued') { job.status = 'error'; job.error = 'Önceki oturum kesildi. Yeniden deneyerek devam edebilirsiniz.'; }
  }
  get busy() { return this.active.size + this.inspections.size + Number(this.updating); }
  get ready() { return fs.existsSync(this.executable) && fs.existsSync(this.ffmpeg) && fs.existsSync(this.ffprobe); }
  snapshot() {
    let version = '';
    try { version = fs.readFileSync(path.join(this.root, 'tools/yt-dlp/version.txt'), 'utf8').replace(/^\uFEFF/, '').trim(); } catch {}
    return { ready: this.ready, version, updating: this.updating, active: this.active.size, inspecting: this.inspections.size,
      jobs: this.jobs.map(({ options, ...job }) => job) };
  }
  changed(save = true) {
    if (save) {
      try {
        fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify({ jobs: this.jobs }));
        fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
      } catch (error) { console.error('İndirme oturumu kaydedilemedi:', error.message); }
    }
    this.onChange();
  }
  baseArgs() {
    return ['--ignore-config', '--no-plugin-dirs', '--no-cache-dir', '--force-ipv4', '--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`, '--encoding', 'utf-8', '--socket-timeout', '30', '--retries', '3', '--fragment-retries', '3', '--ffmpeg-location', path.dirname(this.ffmpeg)];
  }
  async inspect(value) {
    if (!this.ready || this.updating) throw new Error('YouTube motorunu kurun veya güncellemenin tamamlanmasını bekleyin.');
    if (this.inspections.size) throw new Error('Başka bir bağlantı inceleniyor. Tamamlanmasını bekleyin veya incelemeyi durdurun.');
    const normalized = normalizeYouTubeUrl(value.url, value.scope);
    const controller = new AbortController(), id = randomUUID(); this.inspections.set(id, controller); this.changed(false);
    try {
      const args = [...this.baseArgs(), '--flat-playlist', '--dump-single-json', '--skip-download', normalized.kind === 'playlist' ? '--yes-playlist' : '--no-playlist', '--', normalized.url];
      const result = await this.runner(this.executable, args, { signal: controller.signal, timeout: 180000 });
      const info = JSON.parse(result.stdout);
      const list = info.entries || [info];
      const entries = list.map((entry, index) => {
        const available = entry && VIDEO_ID.test(entry.id || '') && !['private', 'premium_only', 'subscriber_only', 'needs_auth'].includes(entry.availability) && !['is_live', 'is_upcoming'].includes(entry.live_status) && !entry.is_live && !/^\[(Private|Deleted) video\]$/i.test(entry.title || '');
        return { id: entry?.id || `unavailable-${index}`, index: index + 1, title: entry?.title || 'Erişilemeyen video', author: entry?.uploader || entry?.channel || '', duration: Number(entry?.duration) || 0, available: Boolean(available) };
      });
      if (!entries.length) throw new Error('Oynatma listesi boş veya erişilemiyor.');
      const preview = { id, title: info.title || entries[0].title, kind: normalized.kind, url: normalized.url, entries, createdAt: Date.now() };
      for (const [key, old] of this.previews) if (Date.now() - old.createdAt > 3600000) this.previews.delete(key);
      this.previews.set(id, preview); return preview;
    } catch (error) { throw new Error(controller.signal.aborted ? 'İnceleme durduruldu.' : youtubeError(error)); }
    finally { this.inspections.delete(id); this.changed(false); }
  }
  cancelInspection() { for (const controller of this.inspections.values()) controller.abort(); }
  enqueue(value, settings) {
    if (!this.ready || this.updating) throw new Error('YouTube motoru hazır değil.');
    const preview = this.previews.get(value.previewId);
    if (!preview) throw new Error('Bağlantıyı yeniden inceleyin; önizleme oturumu sona ermiş.');
    const options = { ...downloadOptions(value), outputDir: settings.outputDir };
    if (!Array.isArray(value.ids)) throw new Error('İndirilecek videoları seçin.');
    const ids = new Set(value.ids);
    let added = 0, skipped = 0;
    for (const entry of preview.entries) {
      if (!ids.has(entry.id) || !entry.available) continue;
      if (this.jobs.some(j => j.videoId === entry.id && JSON.stringify(j.options) === JSON.stringify(options) && (['queued', ...runningStates].includes(j.status) || (j.status === 'done' && fs.existsSync(j.output))))) { skipped++; continue; }
      this.jobs.push({ id: randomUUID(), videoId: entry.id, title: entry.title, author: entry.author, duration: entry.duration,
        playlist: preview.kind === 'playlist' ? preview.title : '', index: preview.kind === 'playlist' ? entry.index : null,
        url: `https://www.youtube.com/watch?v=${entry.id}`, format: options.format, bitrate: options.bitrate, resolution: options.resolution,
        options, status: 'queued', progress: 0, createdAt: new Date().toISOString() }); added++;
    }
    if (!added && !skipped) throw new Error('İndirilebilir en az bir video seçin.');
    this.changed(); this.pump(); return { added, skipped };
  }
  pump() {
    if (this.stopping || this.updating) return;
    for (const job of this.jobs) {
      if (this.active.size >= 2) break;
      if (job.status === 'queued') void this.download(job);
    }
  }
  async probe(file, signal) {
    const result = await this.runner(this.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { signal, timeout: 60000 });
    return JSON.parse(result.stdout);
  }
  workDir(job) { return path.join(this.work, job.id); }
  async clean(job) {
    const dir = path.resolve(this.workDir(job));
    if (path.dirname(dir) !== path.resolve(this.work) || !/^[a-f0-9-]{36}$/.test(job.id)) throw new Error('Geçersiz çalışma klasörü.');
    await fsp.rm(dir, { recursive: true, force: true });
  }
  async publish(job, temp) {
    const folder = path.join(job.options.outputDir, 'YouTube', ...(job.playlist ? [outputBase(`${job.playlist}.tmp`, job.options.ascii)] : []));
    await fsp.mkdir(folder, { recursive: true });
    const base = `${job.index ? `${String(job.index).padStart(3, '0')} - ` : ''}${outputBase(`${job.title}.tmp`, job.options.ascii)} [${job.videoId}]`;
    for (let n = 0; ; n++) {
      const target = path.join(folder, `${base}${n ? ` (${n + 1})` : ''}.${job.format}`);
      try { await fsp.copyFile(temp, target, constants.COPYFILE_EXCL); return target; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }
  async download(job) {
    const controller = new AbortController(), signal = controller.signal;
    this.active.set(job.id, controller); job.status = 'downloading'; job.error = ''; job.warning = ''; job.progress = 0; this.changed();
    const work = this.workDir(job);
    try {
      await fsp.mkdir(work, { recursive: true });
      let downloaded, last = 0;
      const args = [...this.baseArgs(), '--no-playlist', '--no-simulate', '--newline', '--progress', '--progress-delta', '0.5', '--windows-filenames', '--continue',
        '--match-filters', '!is_live & !is_upcoming', '-o', path.join(work, 'source.%(ext)s'),
        '--print', 'before_dl:RW_META:%(title)j\t%(uploader)j\t%(duration)j', '--print', 'after_move:RW_FILE:%(filepath)j',
        '--progress-template', 'download:RW_PROGRESS:%(progress)j'];
      if (job.format === 'mp3') {
        args.push('-f', 'bestaudio/best'); if (job.options.cover) args.push('--write-thumbnail');
      } else {
        const height = `[height<=${job.resolution}]`;
        args.push('-f', `bestvideo${height}+bestaudio/best${height}`, '-S', 'res,vcodec:h264,acodec:aac', '--merge-output-format', 'mkv');
      }
      args.push('--', job.url);
      await this.runner(this.executable, args, { signal, onLine: line => {
        if (line.startsWith('RW_FILE:')) downloaded = JSON.parse(line.slice(8));
        else if (line.startsWith('RW_META:')) {
          const [title, author, seconds] = line.slice(8).split('\t').map(v => JSON.parse(v));
          if (typeof title === 'string') job.title = title;
          if (typeof author === 'string') job.author = author;
          if (Number.isFinite(seconds)) job.duration = seconds;
        } else if (line.startsWith('RW_PROGRESS:')) {
          const p = JSON.parse(line.slice(12));
          const total = p.total_bytes || p.total_bytes_estimate;
          job.progress = total ? Math.max(0, Math.min(100, Math.round(p.downloaded_bytes / total * 100))) : 0;
          job.speed = Number(p.speed) || 0; job.eta = Number(p.eta) || 0;
          if (Date.now() - last > 400) { this.changed(false); last = Date.now(); }
        }
      } });
      if (signal.aborted) throw new Error('İşlem durduruldu.');
      if (!downloaded || path.dirname(path.resolve(downloaded)) !== path.resolve(work)) throw new Error('İndirilen dosya bulunamadı.');
      const info = await this.probe(downloaded, signal);
      job.status = 'processing'; job.progress = 0; job.speed = 0; this.changed();
      const temp = path.join(work, `final.${job.format}`);
      const files = await fsp.readdir(work);
      const thumbnail = job.options.cover && files.find(f => /^source\.(jpg|jpeg|png|webp)$/i.test(f));
      const convert = async cover => {
        let ffArgs;
        if (job.format === 'mp3') {
          if (!info.streams.some(s => s.codec_type === 'audio')) throw new Error('Ses akışı bulunamadı.');
          ffArgs = conversionArgs(downloaded, temp, info, job.options, cover, cover && thumbnail ? path.join(work, thumbnail) : null);
        } else {
          const video = info.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
          const audio = info.streams.find(s => s.codec_type === 'audio');
          if (!video) throw new Error('Video akışı bulunamadı.');
          ffArgs = ['-hide_banner', '-nostdin', '-y', '-i', downloaded, '-map', '0:v:0', '-map', '0:a:0?', '-map_chapters', '-1', '-c:v', video.codec_name === 'h264' ? 'copy' : 'libx264'];
          if (video.codec_name !== 'h264') ffArgs.push('-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p');
          ffArgs.push('-c:a', audio?.codec_name === 'aac' ? 'copy' : 'aac');
          if (audio?.codec_name !== 'aac') ffArgs.push('-b:a', '192k');
          ffArgs.push('-movflags', '+faststart', '-threads', '2', '-progress', 'pipe:1', '-nostats', temp);
        }
        ffArgs.splice(-1, 0, '-metadata', `title=${job.title}`, '-metadata', `artist=${job.author || ''}`, '-metadata', `album=${job.playlist || ''}`);
        await this.runner(this.ffmpeg, ffArgs, { signal, onLine: line => {
          const match = /^out_time_ms=(\d+)/.exec(line);
          if (match && job.duration) job.progress = Math.min(99, Math.round(Number(match[1]) / 1000000 / job.duration * 100));
          if (Date.now() - last > 400) { this.changed(false); last = Date.now(); }
        } });
        const verified = await this.probe(temp, signal);
        if (job.format === 'mp3' && !verified.streams.some(s => s.codec_name === 'mp3')) throw new Error('Ses akışı doğrulanamadı.');
        if (job.format === 'mp4' && !verified.streams.some(s => s.codec_type === 'video' && s.codec_name === 'h264')) throw new Error('Video akışı doğrulanamadı.');
        job.actualHeight = verified.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)?.height;
      };
      try { await convert(true); }
      catch (error) {
        if (signal.aborted || job.format !== 'mp3' || !job.options.cover) throw error;
        job.warning = 'Kapak işlenemedi; ses kapaksız kaydedildi.'; await convert(false);
      }
      if (signal.aborted) throw new Error('İşlem durduruldu.');
      job.status = 'saving'; this.changed(false);
      job.output = await this.publish(job, temp); job.outputSize = (await fsp.stat(job.output)).size;
      job.status = 'done'; job.progress = 100; job.completedAt = new Date().toISOString();
      await this.clean(job).catch(() => {});
    } catch (error) { job.status = signal.aborted ? 'canceled' : 'error'; job.error = signal.aborted ? '' : youtubeError(error); }
    finally { this.active.delete(job.id); this.changed(); this.pump(); }
  }
  cancel(id) {
    for (const job of this.jobs) if ((!id || id === job.id) && job.status !== 'saving') {
      if (job.status === 'queued') job.status = 'canceled';
      this.active.get(job.id)?.abort();
    }
    this.changed();
  }
  retry(id) {
    if (this.updating || !this.ready) throw new Error('Motor hazır değil.');
    const job = this.jobs.find(j => j.id === id);
    if (!job || this.active.has(id) || !['error', 'canceled'].includes(job.status)) throw new Error('Bu işlem şu anda yeniden başlatılamaz.');
    job.status = 'queued'; job.error = ''; this.changed(); this.pump();
  }
  async remove({ id, completed }) {
    const targets = this.jobs.filter(j => (completed ? j.status === 'done' : j.id === id) && !this.active.has(j.id) && j.status !== 'queued');
    for (const job of targets) await this.clean(job);
    const ids = new Set(targets.map(j => j.id)); this.jobs = this.jobs.filter(j => !ids.has(j.id)); this.changed();
  }
  async update() {
    if (this.busy || this.jobs.some(j => j.status === 'queued')) throw new Error('Motoru güncellemeden önce devam eden indirmeleri ve incelemeyi durdurun.');
    this.updating = true; this.changed(false);
    try {
      await this.runner('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.root, 'scripts/install-youtube.ps1'), '-Update'], { timeout: 900000 });
      return { ok: true };
    } catch { throw new Error('Motor güncellenemedi. İnterneti kontrol edip tekrar deneyin.'); }
    finally { this.updating = false; this.changed(false); this.pump(); }
  }
  shutdown() { this.stopping = true; this.cancelInspection(); for (const controller of this.active.values()) controller.abort(); }
}
