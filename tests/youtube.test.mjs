import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YouTubeManager, normalizeYouTubeUrl, downloadOptions, youtubeError } from '../lib/youtube.mjs';
import { runProcess } from '../lib/process.mjs';
import { resolveToolchain } from '../lib/platform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { ffmpeg, ffprobe, ytdlp } = resolveToolchain(root);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const probe = async file => JSON.parse((await runProcess(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file])).stdout);

test('YouTube URLs are canonicalized; external addresses and commands are rejected', () => {
  assert.equal(normalizeYouTubeUrl('https://youtu.be/BaW_jenozKc?t=5').url, 'https://www.youtube.com/watch?v=BaW_jenozKc');
  assert.equal(normalizeYouTubeUrl('https://youtube.com/shorts/BaW_jenozKc').kind, 'video');
  const mixed = 'https://www.youtube.com/watch?v=BaW_jenozKc&list=PL1234567890abcd';
  assert.equal(normalizeYouTubeUrl(mixed).kind, 'video');
  assert.equal(normalizeYouTubeUrl(mixed, 'playlist').url, 'https://www.youtube.com/playlist?list=PL1234567890abcd');
  for (const value of ['https://youtube.com.evil.example/watch?v=BaW_jenozKc', 'http://127.0.0.1/', 'file:///C:/secret', '--exec calc', 'https://evil@youtube.com/watch?v=BaW_jenozKc', 'https://youtube.com:8080/watch?v=BaW_jenozKc', 'https://youtube.com/@channel']) assert.throws(() => normalizeYouTubeUrl(value));
  assert.throws(() => downloadOptions({ format: 'exe' })); assert.throws(() => downloadOptions({ resolution: 999 }));
  assert.match(youtubeError(new Error('Sign in to confirm you are not a bot')), /sign in|verification/i);
});

test('Downloader manager tolerates a malformed persisted job list', async () => {
  const dir = path.join(root, 'test-artifacts', `youtube-state-${Date.now()}`);
  await fs.mkdir(path.join(dir, 'youtube'), { recursive: true });
  await fs.writeFile(path.join(dir, 'youtube', 'state.json'), JSON.stringify({ jobs: { malformed: true } }));
  const manager = new YouTubeManager({ root, data: dir, ffmpeg, ffprobe });
  assert.deepEqual(manager.jobs, []);
  manager.shutdown();
});

test('YouTube queue and real FFmpeg MP3/MP4 preparation', { timeout: 90000 }, async t => {
  const dir = path.join(root, 'test-artifacts', `youtube-${Date.now()}`); await fs.mkdir(dir, { recursive: true });
  const audio = path.join(dir, 'audio.m4a'), video = path.join(dir, 'video.webm'), cover = path.join(dir, 'cover.jpg');
  await runProcess(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:a', 'aac', audio]);
  await runProcess(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=900x700', '-frames:v', '1', cover]);
  await runProcess(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', video]);
  const metadata = { title: 'Test List / Path', entries: [
    { id: 'aaaaaaaaaaa', title: 'Song <test>', uploader: 'Artist', duration: 2 },
    { id: 'bbbbbbbbbbb', title: 'Video', duration: 2 },
    { id: 'ccccccccccc', title: '[Private video]', availability: 'private' },
    { id: 'ddddddddddd', title: 'Faulty file', duration: 2 },
    { id: 'eeeeeeeeeee', title: 'Cancel test', duration: 2 },
  ] };
  const executable = ytdlp;
  let hold = true;
  const calls = [];
  const runner = async (command, args, options = {}) => {
    if (command !== executable) return runProcess(command, args, options);
    calls.push(args);
    if (args.includes('--dump-single-json')) return { stdout: JSON.stringify(metadata), stderr: '' };
    const id = args.at(-1).split('=').at(-1);
    if (id === 'ddddddddddd') throw new Error('Video unavailable');
    if (id === 'eeeeeeeeeee' && hold) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 10000);
      const stop = () => { clearTimeout(timer); reject(new Error('Stopped')); };
      if (options.signal.aborted) stop(); else options.signal.addEventListener('abort', stop, { once: true });
    });
    const isVideo = args.includes('--merge-output-format');
    const template = args[args.indexOf('-o') + 1]; const file = template.replace('%(ext)s', isVideo ? 'webm' : 'm4a');
    await fs.copyFile(isVideo ? video : audio, file);
    if (args.includes('--write-thumbnail')) await fs.copyFile(cover, template.replace('%(ext)s', 'jpg'));
    options.onLine('RW_META:"Song <test>"\t"Artist"\t2');
    options.onLine('RW_PROGRESS:{"downloaded_bytes":500,"total_bytes":1000,"speed":1000,"eta":1}');
    options.onLine(`RW_FILE:${JSON.stringify(file)}`); return { stdout: '', stderr: '' };
  };
  const manager = new YouTubeManager({ root, data: dir, ffmpeg, ffprobe, executable, runner, availability: () => true });
  t.after(() => manager.shutdown());
  const preview = await manager.inspect({ url: 'https://www.youtube.com/playlist?list=PL1234567890abcd' });
  const outputDir = path.join(dir, 'output');
  async function waitDone() {
    for (let n = 0; n < 200; n++) { if (!manager.active.size && !manager.jobs.some(j => j.status === 'queued')) return; await pause(50); }
    throw new Error('Queue timeout');
  }
  await t.test('Playlist selection, unavailable video and duplicate check', async () => {
    assert.equal(preview.entries[2].available, false);
    const result = manager.enqueue({ previewId: preview.id, ids: ['aaaaaaaaaaa', 'ccccccccccc'], format: 'mp3' }, { outputDir });
    assert.equal(result.added, 1);
    assert.equal(manager.enqueue({ previewId: preview.id, ids: ['aaaaaaaaaaa'], format: 'mp3' }, { outputDir }).skipped, 1);
    await waitDone(); const job = manager.jobs[0]; assert.equal(job.status, 'done', job.error);
    const info = await probe(job.output); const stream = info.streams.find(s => s.codec_type === 'audio');
    assert.equal(stream.codec_name, 'mp3'); assert.equal(stream.sample_rate, '44100'); assert.equal(stream.channels, 2); assert.equal(stream.bit_rate, '192000');
    assert.equal(info.format.tags.title, 'Song <test>'); assert.equal(info.format.tags.artist, 'Artist');
    assert.ok(info.streams.some(s => s.disposition?.attached_pic === 1 && s.width <= 600));
    assert.ok(Number(info.format.duration) >= 2);
    const bytes = await fs.readFile(job.output); assert.equal(bytes[3], 3);
    assert.match(path.basename(job.output), /^001 - /);
  });
  await t.test('WebM/VP9/Opus becomes real H.264/AAC MP4', async () => {
    manager.enqueue({ previewId: preview.id, ids: ['bbbbbbbbbbb'], format: 'mp4', resolution: 720 }, { outputDir });
    await waitDone(); const job = manager.jobs.at(-1); assert.equal(job.status, 'done', job.error);
    const info = await probe(job.output);
    assert.equal(info.streams.find(s => s.codec_type === 'video').codec_name, 'h264');
    assert.equal(info.streams.find(s => s.codec_type === 'audio').codec_name, 'aac');
    assert.equal(job.actualHeight, 180); assert.match(job.output, /\.mp4$/);
    assert.ok(calls.some(args => args.includes('bestvideo[height<=720]+bestaudio/best[height<=720]')));
  });
  await t.test('One error does not stop other videos; cancel and resume work', async () => {
    manager.enqueue({ previewId: preview.id, ids: ['ddddddddddd', 'eeeeeeeeeee'], format: 'mp3' }, { outputDir });
    await pause(20); const canceled = manager.jobs.find(j => j.videoId === 'eeeeeeeeeee'); manager.cancel(canceled.id);
    await waitDone(); assert.equal(canceled.status, 'canceled'); assert.equal(manager.jobs.find(j => j.videoId === 'ddddddddddd').status, 'error');
    hold = false; manager.retry(canceled.id); await waitDone(); assert.equal(canceled.status, 'done', canceled.error);
  });
  await t.test('Session is preserved; removing from list does not delete MP3/MP4', async () => {
    const restored = new YouTubeManager({ root, data: dir, ffmpeg, ffprobe, executable, runner, availability: () => true });
    assert.equal(restored.jobs.length, manager.jobs.length);
    const output = manager.jobs[0].output; await manager.remove({ completed: true }); assert.ok((await fs.stat(output)).size > 0);
    assert.equal(manager.jobs.length, 1); assert.equal(manager.jobs[0].status, 'error');
  });
});
