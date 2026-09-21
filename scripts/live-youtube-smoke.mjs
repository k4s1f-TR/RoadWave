// Explicit online smoke check, separate from the deterministic npm test suite.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { YouTubeManager } from '../lib/youtube.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'test-artifacts', `live-youtube-${Date.now()}`);
const url = process.argv[2] || 'https://www.youtube.com/watch?v=YE7VzlLtp-4';
const onlyInspect = process.argv.includes('--inspect-only');
let last = '';
const manager = new YouTubeManager({ root, data: directory, ffmpeg: path.join(root, 'tools/ffmpeg/ffmpeg.exe'), ffprobe: path.join(root, 'tools/ffmpeg/ffprobe.exe'), onChange: () => {
  const status = manager.jobs.map(j => `${j.format}: ${j.status} ${j.progress}% ${j.error || ''}`).join(' | ');
  if (status !== last) { last = status; console.log(status); }
} });
try {
  const preview = await manager.inspect({ url });
  console.log(JSON.stringify({ title: preview.title, kind: preview.kind, count: preview.entries.length, available: preview.entries.filter(e => e.available).length }));
  if (!onlyInspect) {
    const first = preview.entries.find(e => e.available);
    if (!first) throw new Error('No available test video');
    for (const format of ['mp3', 'mp4']) manager.enqueue({ previewId: preview.id, ids: [first.id], format, resolution: 360, bitrate: 192, cover: true }, { outputDir: path.join(directory, 'output') });
    const deadline = Date.now() + 15 * 60000;
    while (manager.active.size || manager.jobs.some(j => j.status === 'queued')) {
      if (Date.now() > deadline) { manager.shutdown(); throw new Error('Live smoke check timeout'); }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    const result = manager.jobs.map(({ format, status, error, output, outputSize }) => ({ format, status, error, output, outputSize }));
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    if (manager.jobs.some(j => j.status !== 'done')) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { manager.shutdown(); }
