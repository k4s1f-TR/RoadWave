import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const youtubeScript = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const readyJob = { id: 'test-1', name: '<img src=x onerror=alert(1)>.m4a', size: 123456, duration: 180, hasCover: true, status: 'ready', progress: 0 };
function setup(t, jobs = []) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:47831', runScripts: 'outside-only' });
  const w = dom.window;
  w.scrollTo = () => {};
  const current = { token: 'test-token', version: '1.0.0', engineReady: true, active: 0, jobs,
    settings: { bitrate: 192, cover: true, ascii: false, parallel: 2, outputDir: 'C:\\Music' },
    youtube: { ready: true, active: 0, jobs: [], version: 'test' } };
  const requests = [];
  let events;
  w.EventSource = class {
    constructor() { events = this; }
    close() {}
  };
  w.fetch = async (url, options) => {
    if (!options) return { ok: true, json: async () => structuredClone(current) };
    const data = JSON.parse(options.body); requests.push({ url, data, headers: options.headers });
    if (url === '/api/youtube/inspect') return { ok: true, json: async () => ({ id: 'preview-test', kind: 'playlist', title: 'Test Listesi', entries: [
      { id: 'aaaaaaaaaaa', title: '<img src=x onerror=alert(1)>', index: 1, available: true, duration: 10 },
      { id: 'bbbbbbbbbbb', title: 'İkinci parça', index: 2, available: true, duration: 12 },
      { id: 'ccccccccccc', title: 'Özel video', index: 3, available: false },
    ] }) };
    if (url === '/api/youtube/enqueue') return { ok: true, json: async () => ({ added: data.ids.length, skipped: 0 }) };
    if (url === '/api/settings') current.settings = { ...current.settings, ...data };
    return { ok: true, json: async () => url === '/api/settings' ? structuredClone(current.settings) : { ok: true } };
  };
  w.eval(`${script}\n${youtubeScript}`);
  t.after(() => w.close());
  return { w, current, requests, disconnect: () => events.onerror(), send: value => events.onmessage({ data: JSON.stringify(value) }) };
}

test('Boş kuyruk güvenli başlangıç durumu ve dosya seçimi', async t => {
  const { w } = setup(t); await tick();
  assert.equal(w.document.querySelector('#start-button').disabled, true);
  assert.match(w.document.querySelector('#connection').textContent, /bağlı/);
  let selected = false; w.document.querySelector('#file-input').click = () => selected = true;
  w.document.querySelector('#add-files').click(); assert.equal(selected, true);
  for (const use of w.document.querySelectorAll('svg use')) assert.ok(w.document.querySelector(use.getAttribute('href')), 'SVG symbol exists');
});

test('YouTube sekmesi, güvenli playlist önizlemesi, seçim ve MP4 indirme düğmesi', async t => {
  const { w, requests } = setup(t); await tick();
  w.document.querySelector('#nav-youtube').click();
  assert.equal(w.document.querySelector('#youtube-panel').classList.contains('hidden'), false);
  assert.equal(w.document.querySelector('#converter-panel').classList.contains('hidden'), true);
  w.document.querySelector('#yt-url').value = 'https://www.youtube.com/playlist?list=PL1234567890abcd';
  w.document.querySelector('#yt-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  assert.equal(w.document.querySelector('#yt-preview-title').textContent, 'Test Listesi');
  assert.equal(w.document.querySelector('#yt-preview-list img'), null);
  assert.equal(w.document.querySelector('[data-yt-entry="ccccccccccc"]').disabled, true);
  const checkbox = w.document.querySelector('[data-yt-entry="bbbbbbbbbbb"]'); checkbox.click();
  assert.match(w.document.querySelector('#yt-selection-count').textContent, /1 seçildi/);
  w.document.querySelector('[data-yt-format="mp4"]').click();
  assert.equal(w.document.querySelector('#yt-video-options').classList.contains('hidden'), false);
  w.document.querySelector('#yt-enqueue').click(); await tick();
  assert.equal(requests.at(-1).url, '/api/youtube/enqueue');
  assert.deepEqual(requests.at(-1).data.ids, ['aaaaaaaaaaa']); assert.equal(requests.at(-1).data.format, 'mp4');
  w.document.querySelector('#nav-convert').click(); assert.equal(w.document.querySelector('#converter-panel').classList.contains('hidden'), false);
});

test('YouTube kuyruk ilerlemesi, iptal, MP4 oynatma ve temizleme', async t => {
  const { w, requests, current, send } = setup(t); await tick();
  const job = { id: 'yt-test', title: 'Video örneği', status: 'downloading', format: 'mp4', resolution: 720, duration: 30, progress: 25, speed: 1048576, eta: 10 };
  send({ ...current, youtube: { ...current.youtube, active: 1, jobs: [job] } });
  assert.equal(w.document.querySelector('#yt-jobs [role="progressbar"]').getAttribute('aria-valuenow'), '25');
  w.document.querySelector('[data-yt-action="cancel"]').click(); await tick(); assert.equal(requests.at(-1).url, '/api/youtube/cancel');
  send({ ...current, youtube: { ...current.youtube, jobs: [{ ...job, status: 'done', outputSize: 1000000, actualHeight: 720 }] } });
  w.document.querySelector('#yt-player-dialog').showModal = () => {};
  w.document.querySelector('#yt-video-player').play = async () => {};
  w.document.querySelector('[data-yt-action="play"]').click(); await tick();
  assert.equal(w.document.querySelector('#yt-video-player').getAttribute('src'), '/api/audio/yt-test');
  assert.equal(w.document.querySelector('#yt-audio-player').classList.contains('hidden'), true);
  w.document.querySelector('#yt-clear').click(); await tick(); assert.equal(requests.at(-1).url, '/api/youtube/remove'); assert.equal(requests.at(-1).data.completed, true);
});

test('YouTube inceleme hatası kalıcı ve anlaşılır gösterilir', async t => {
  const { w } = setup(t); await tick();
  w.fetch = async () => ({ ok: false, json: async () => ({ error: 'YouTube bağlantısı kurulamadı.' }) });
  w.document.querySelector('#yt-url').value = 'https://youtu.be/BaW_jenozKc';
  w.document.querySelector('#yt-form').dispatchEvent(new w.Event('submit', { cancelable: true })); await tick();
  assert.equal(w.document.querySelector('#yt-error').classList.contains('hidden'), false);
  assert.match(w.document.querySelector('#yt-error').textContent, /bağlantısı kurulamadı/);
  assert.equal(w.document.querySelector('#yt-inspect').disabled, false);
});

test('Dosya adları metin olarak gösterilir; başlatma ve ayarlar bağlanır', async t => {
  const { w, requests } = setup(t, [readyJob]); await tick();
  assert.equal(w.document.querySelector('#start-button').disabled, false);
  assert.equal(w.document.querySelector('.file-title').textContent, readyJob.name);
  assert.equal(w.document.querySelector('#job-list img'), null, 'No HTML injection from filename');
  w.document.querySelector('[data-bitrate="320"]').click(); await tick();
  assert.equal(requests[0].url, '/api/settings'); assert.equal(requests[0].data.bitrate, 320);
  assert.equal(requests[0].headers['X-Roadwave-Token'], 'test-token');
  assert.equal(w.document.querySelector('[data-bitrate="320"]').classList.contains('active'), true);
  w.document.querySelector('#start-button').click(); await tick(); assert.equal(requests.at(-1).url, '/api/start');
});

test('Canlı ilerleme, tamamlanan filtresi, ön dinleme ve bağlantı kaybı', async t => {
  const { w, current, send, requests, disconnect } = setup(t, [readyJob]); await tick();
  send({ ...current, active: 1, jobs: [{ ...readyJob, status: 'converting', progress: 43 }] });
  assert.equal(w.document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '43');
  assert.equal(w.document.querySelector('#cancel-all').classList.contains('hidden'), false);
  w.document.querySelector('[data-action="cancel"]').click(); await tick(); assert.equal(requests.at(-1).url, '/api/cancel');
  send({ ...current, jobs: [{ ...readyJob, status: 'done', bitrate: 192, outputSize: 987654 }] });
  assert.equal(w.document.querySelector('#done-count').textContent, '1');
  assert.ok(w.document.querySelector('[aria-label="MP3 indir"]'));
  w.document.querySelector('[data-filter="done"]').click(); assert.equal(w.document.querySelectorAll('.job-row').length, 1);
  w.document.querySelector('#player-dialog').showModal = () => {};
  w.document.querySelector('#audio-player').play = async () => {};
  w.document.querySelector('[data-action="play"]').click(); await tick();
  assert.equal(w.document.querySelector('#audio-player').getAttribute('src'), '/api/audio/test-1');
  assert.equal(w.document.querySelector('#player-title').textContent, readyJob.name);
  disconnect(); assert.equal(w.document.querySelector('#start-button').disabled, true);
  assert.match(w.document.querySelector('#connection').textContent, /bekleniyor/);
});
