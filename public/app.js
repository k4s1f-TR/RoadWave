const $ = selector => document.querySelector(selector);
const FORMAT_CONFIG = {
  mp3: { label: 'MP3', profile: '44.1 kHz · Stereo · ID3v2.3', mode: 'kbps · constant bitrate', details: '44.1 kHz · stereo', defaultQuality: 192, options: [[128, '128', 'Compact'], [192, '192', 'Balanced'], [256, '256', 'High'], [320, '320', 'Maximum']] },
  aac: { label: 'M4A', profile: 'AAC · 44.1 kHz · Stereo', mode: 'kbps · AAC in M4A', details: '44.1 kHz · stereo', defaultQuality: 128, options: [[96, '96', 'Compact'], [128, '128', 'Balanced'], [192, '192', 'High'], [256, '256', 'Maximum']] },
  flac: { label: 'FLAC', profile: 'Lossless · 44.1 kHz · Stereo', mode: 'compression level · lossless', details: 'Original audio quality', defaultQuality: 5, options: [[0, '0', 'Fast'], [5, '5', 'Balanced'], [8, '8', 'High compression'], [12, '12', 'Maximum compression']] },
  wav: { label: 'WAV', profile: 'PCM · 44.1 kHz · Stereo', mode: 'bit PCM · lossless', details: '44.1 kHz · stereo', defaultQuality: 16, options: [[16, '16', 'Standard'], [24, '24', 'Studio']] },
  opus: { label: 'OPUS', profile: 'Opus VBR · 48 kHz · Stereo', mode: 'kbps · variable bitrate', details: '48 kHz · stereo', defaultQuality: 128, options: [[64, '64', 'Voice'], [96, '96', 'Compact'], [128, '128', 'Balanced'], [160, '160', 'High'], [192, '192', 'Maximum']] },
  ogg: { label: 'OGG', profile: 'Vorbis VBR · 44.1 kHz · Stereo', mode: 'Vorbis quality level', details: '44.1 kHz · stereo', defaultQuality: 5, options: [[4, 'Q4', 'Compact'], [5, 'Q5', 'Balanced'], [6, 'Q6', 'High'], [8, 'Q8', 'Maximum']] }
};
const formatConfig = id => FORMAT_CONFIG[id] || FORMAT_CONFIG.mp3;
const formatLabel = id => formatConfig(id).label;
let state = { jobs: [], settings: {} }, token = '', filter = 'all', uploading = false, connected = false;
let eventSource, lastJobRender = '', settingsBusy = false;
let intentionallyStopped = false;
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const size = value => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
const duration = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
function toast(message, error = false) {
  const el = document.createElement('div'); el.className = `toast${error ? ' error' : ''}`;
  const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label', 'Close notification'); close.onclick = () => el.remove();
  el.append(close, document.createTextNode(message)); $('#toast-stack').append(el);
  setTimeout(() => el.remove(), error ? 12000 : 5000);
}
async function api(url, data = {}) {
  const res = await fetch(`/api/${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Soundwave-Token': token }, body: JSON.stringify(data) });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error || 'Operation could not be completed.');
  return value;
}
function safeAction(fn) { return async (...args) => { try { await fn(...args); } catch (error) { toast(error.message, true); } }; }
function setConnected(value) {
  connected = value;
  $('#connection').classList.toggle('offline', !value);
  $('#connection').innerHTML = '<i></i> ' + (value ? 'Local engine connected' : 'Waiting for connection');
  if (value) $('#connection').title = '';
  else $('#connection').title = 'Cannot connect to local server. Make sure the start window is open.';
  updateStart();
  window.dispatchEvent(new CustomEvent('soundwave-state'));
}
function updateStart() {
  const ready = state.jobs.filter(j => j.status === 'ready').length;
  $('#start-button').disabled = !ready || !connected || !state.engineReady || settingsBusy || uploading;
  const label = formatLabel(state.settings.format);
  $('#start-button span').textContent = ready ? `Convert ${ready} files to ${label}` : `Convert to ${label}`;
  $('#start-hint').textContent = uploading ? 'Adding files…' : ready ? 'Local process · Originals preserved' : state.active ? 'Converting continues…' : 'Add audio files to start';
}
function render() {
  const jobs = state.jobs, done = jobs.filter(j => j.status === 'done').length;
  $('#queue-count').textContent = jobs.length;
  $('#done-count').textContent = done;
  $('#queue-summary').textContent = jobs.length ? `${jobs.length} tracks · ${duration(jobs.reduce((a, j) => a + j.duration, 0))} total${done ? ` · ${done} completed` : ''}` : "Let's start by adding some music.";
  $('#total-size').textContent = size(jobs.reduce((a, j) => a + j.size, 0));
  $('#clear-done').disabled = !done;
  const running = jobs.filter(j => ['queued', 'converting'].includes(j.status)).length;
  $('#cancel-all').classList.toggle('hidden', !running);
  const completedFormats = [...new Set(jobs.filter(j => j.status === 'done').map(j => formatLabel(j.format)))];
  const completedLabel = completedFormats.length === 1 ? completedFormats[0] : 'files';
  $('#queue-footer-text').textContent = running ? `${running} files processing · ${state.active} active` : done ? `${done} ${completedLabel} ready` : 'Ready to convert';
  $('#engine-warning').classList.toggle('hidden', state.engineReady);
  const visible = filter === 'done' ? jobs.filter(j => j.status === 'done') : jobs;
  $('#empty-state').classList.toggle('hidden', visible.length > 0);
  $('#empty-state strong').textContent = filter === 'done' ? 'Completed tracks will appear here.' : 'Start by adding music.';
  const rows = visible.map(job => {
    const meta = [size(job.size), duration(job.duration), job.hasCover ? 'Cover found' : 'No cover'];
    const formatId = job.format || 'mp3', outputFormat = formatLabel(formatId);
    const quality = job.quality ?? (['mp3', 'aac', 'opus'].includes(formatId) ? job.bitrate : formatConfig(formatId).defaultQuality);
    const qualityText = ['mp3', 'aac', 'opus'].includes(formatId) ? `${quality} kbps` : formatId === 'ogg' ? `Q${quality}` : formatId === 'flac' ? `level ${quality}` : formatId === 'wav' ? `${quality}-bit` : '';
    const status = { ready: 'Ready to convert', queued: 'Waiting in queue', converting: `Converting · ${job.progress}%`, done: `${outputFormat} ready${qualityText ? ` · ${qualityText}` : ''} · ${size(job.outputSize || 0)}`, error: job.error, canceled: 'Stopped' }[job.status];
    const button = (action, name, label) => `<button class="icon-button" data-action="${action}" data-id="${job.id}" aria-label="${escape(label)}" title="${escape(label)}">${icon(name)}</button>`;
    let actions = '';
    if (job.status === 'done') actions = button('play', 'play', 'Preview') + `<a class="icon-button" href="/api/audio/${job.id}?download" title="Download ${escape(outputFormat)}" aria-label="Download ${escape(outputFormat)}">${icon('download')}</a>` + button('folder', 'folder', 'Open file folder');
    if (['error', 'canceled'].includes(job.status)) actions += button('retry', 'refresh', 'Retry');
    if (['queued', 'converting'].includes(job.status)) actions += button('cancel', 'close', 'Stop conversion');
    else actions += button('remove', 'close', 'Remove from list; keep file');
    return `<article class="job-row" data-job="${job.id}"><div class="file-icon">${icon('music')}<small>${escape(job.name.split('.').pop().toUpperCase())}</small></div><div class="file-main"><span class="file-title" title="${escape(job.name)}">${escape(job.name)}</span><div class="file-meta">${meta.map(escape).join('<span>·</span>')}</div><div class="file-status ${job.status}">${escape(status)}</div>${job.warning ? `<div class="file-status file-warning">${escape(job.warning)}</div>` : ''}${job.status === 'converting' ? `<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${job.progress}" aria-label="Conversion progress"><span style="width:${job.progress}%"></span></div>` : ''}</div><div class="job-actions">${actions}</div></article>`;
  }).join('');
  if (rows !== lastJobRender) {
    const focused = document.activeElement?.dataset;
    $('#job-list').innerHTML = rows; lastJobRender = rows;
    if (focused?.action && focused.id) $(`[data-action="${focused.action}"][data-id="${focused.id}"]`)?.focus({ preventScroll: true });
  }
  $('#output-path').textContent = state.settings.outputDir || 'outputs';
  $('#output-path-button').title = state.settings.outputDir || 'Open output folder';
  if (!settingsBusy) {
    $('#cover-toggle').checked = state.settings.cover;
    $('#ascii-toggle').checked = state.settings.ascii;
    $('#parallel').value = state.settings.parallel;
    const fmt = state.settings.format || 'mp3';
    const config = formatConfig(fmt);
    const quality = Number(state.settings.quality ?? state.settings.bitrate ?? config.defaultQuality);
    $('#quality-options').innerHTML = config.options.map(([value, label]) => `<button data-quality="${value}" class="${value === quality ? 'active' : ''}">${label}</button>`).join('');
    $('#quality-label').textContent = config.options.find(([value]) => value === quality)?.[2] || 'Balanced';
    $('#quality-mode').textContent = config.mode; $('#quality-details').textContent = config.details;
    $('#cover-toggle').disabled = fmt !== 'mp3';
    document.querySelectorAll('[data-format]').forEach(el => el.classList.toggle('active', el.dataset.format === fmt));
    const profileEl = document.querySelector('.car-profile strong');
    if (profileEl) profileEl.textContent = `${config.label} Standard`;
    const profileDescEl = document.querySelector('.car-profile p');
    if (profileDescEl) profileDescEl.textContent = config.profile;
  }
  updateStart();
}
async function saveSettings(change) {
  if (settingsBusy) return;
  settingsBusy = true; updateStart();
  document.querySelectorAll('[data-quality], [data-format], #cover-toggle, #ascii-toggle, #parallel').forEach(el => el.disabled = true);
  try { state.settings = await api('settings', { ...state.settings, ...change }); }
  finally {
    settingsBusy = false;
    document.querySelectorAll('[data-quality], [data-format], #cover-toggle, #ascii-toggle, #parallel').forEach(el => el.disabled = false);
    render();
  }
}
const pendingFiles = [];
function uploadFile(file, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('X-Soundwave-Token', token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => progress(e.lengthComputable ? Math.round(e.loaded / e.total * 100) : 0);
    xhr.onload = () => {
      try { const data = JSON.parse(xhr.responseText); xhr.status < 300 ? resolve(data) : reject(new Error(data.error)); }
      catch { reject(new Error('No response from server.')); }
    };
    xhr.onerror = () => reject(new Error('Cannot connect to local server. Make sure the start window is open.'));
    xhr.send(file);
  });
}
async function addFiles(files) {
  if (!connected) return toast('Check local server connection first.', true);
  const supported = /\.(m4a|aac|mp3|wav|flac|ogg|opus|wma|aiff?|alac|mp4|m4b|webm|mov|mkv|mka)$/i;
  for (const file of files) {
    if (!supported.test(file.name)) { toast(`${file.name}: unsupported file type.`, true); continue; }
    if (state.jobs.some(j => j.name === file.name && j.size === file.size && !['error', 'canceled'].includes(j.status)) || pendingFiles.some(f => f.name === file.name && f.size === file.size)) {
      toast(`${file.name} is already in the list.`); continue;
    }
    pendingFiles.push(file);
  }
  if (uploading || !pendingFiles.length) return;
  uploading = true; updateStart(); $('#upload-status').classList.remove('hidden');
  let added = 0;
  while (pendingFiles.length) {
    const file = pendingFiles.shift();
    try {
      await uploadFile(file, value => { $('#upload-status').textContent = `${file.name} · ${value === 100 ? 'Reading audio info...' : `${value}% local copy`}${pendingFiles.length ? ` — ${pendingFiles.length} in queue` : ''}`; });
      added++;
    } catch (error) { toast(`${file.name}: ${error.message}`, true); }
  }
  uploading = false; $('#upload-status').classList.add('hidden'); updateStart();
  if (added) toast(`${added} files added to conversion queue.`);
}
function chooseFiles() { $('#file-input').click(); }
$('#file-input').addEventListener('change', e => { void addFiles([...e.target.files]); e.target.value = ''; });
$('#dropzone').onclick = chooseFiles; $('#add-files').onclick = chooseFiles;
$('#dropzone').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseFiles(); } };
let dragDepth = 0;
document.addEventListener('dragover', e => { e.preventDefault(); });
document.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('#dropzone').classList.remove('dragging'); if (e.dataTransfer.files.length) void addFiles([...e.dataTransfer.files]); });
$('#dropzone').addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#dropzone').classList.add('dragging'); });
$('#dropzone').addEventListener('dragleave', () => { if (--dragDepth <= 0) $('#dropzone').classList.remove('dragging'); });
$('#quality-options').onclick = safeAction(event => { const button = event.target.closest('[data-quality]'); if (button) return saveSettings({ quality: Number(button.dataset.quality) }); });
document.querySelectorAll('[data-format]').forEach(el => el.onclick = safeAction(() => {
  const config = formatConfig(el.dataset.format);
  return saveSettings({ format: el.dataset.format, quality: config.defaultQuality });
}));
$('#cover-toggle').onchange = safeAction(e => saveSettings({ cover: e.target.checked }));
$('#ascii-toggle').onchange = safeAction(e => saveSettings({ ascii: e.target.checked }));
$('#parallel').onchange = safeAction(e => saveSettings({ parallel: Number(e.target.value) }));
$('#choose-folder').onclick = safeAction(async () => {
  $('#choose-folder').disabled = true; $('#choose-folder').textContent = 'Window open...';
  try { await api('folder'); } finally { $('#choose-folder').disabled = false; $('#choose-folder').textContent = 'Change'; }
});
$('#start-button').onclick = safeAction(async () => { $('#start-button').disabled = true; try { await api('start'); } finally { updateStart(); } });
$('#cancel-all').onclick = safeAction(() => api('cancel'));
$('#shutdown-button').onclick = safeAction(async () => {
  if (uploading) return toast('Wait for files to be added.', true);
  await api('shutdown'); intentionallyStopped = true; eventSource?.close();
  setConnected(false); $('#connection').innerHTML = '<i></i> App closed';
  $('#shutdown-button').disabled = true;
  toast('SoundWave closed. Run the launcher for your operating system to reopen it.');
});
$('#clear-done').onclick = safeAction(async () => { await api('remove', { completed: true }); toast('Completed tasks removed from list. Converted files are kept.'); });
for (const selector of ['#nav-output', '#output-path-button']) $(selector).onclick = safeAction(() => api('open-folder'));

$('#nav-convert').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
document.querySelectorAll('[data-close]').forEach(el => el.onclick = () => document.getElementById(el.dataset.close).close());
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', e => { if (e.target === dialog) { const rect = dialog.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close(); } }));
$('#player-dialog').addEventListener('close', () => $('#audio-player').pause());
$('#audio-player').addEventListener('error', () => toast('Audio file could not be opened. It might be moved, deleted or the drive ejected.', true));
document.querySelectorAll('[data-filter]').forEach(el => el.onclick = () => { filter = el.dataset.filter; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === el)); render(); });
$('#job-list').onclick = safeAction(async e => {
  const button = e.target.closest('[data-action]'); if (!button) return;
  const { action, id } = button.dataset;
  if (action === 'play') {
    const job = state.jobs.find(j => j.id === id);
    $('#player-title').textContent = job.title || job.name;
    $('#audio-player').src = `/api/audio/${id}`;
    $('#player-dialog').showModal();
    await $('#audio-player').play().catch(() => {});
  } else await api({ retry: 'start', cancel: 'cancel', remove: 'remove', folder: 'open-folder' }[action], { id });
});
async function connect() {
  if (intentionallyStopped) return;
  try {
    const response = await fetch('/api/state'); if (!response.ok) throw new Error('No connection');
    state = await response.json(); token = state.token; render(); setConnected(true);
    eventSource?.close(); eventSource = new EventSource('/api/events');
    eventSource.onmessage = e => {
      const next = JSON.parse(e.data);
      const finished = next.jobs.filter(j => j.status === 'done' && state.jobs.some(old => old.id === j.id && old.status === 'converting'));
      state = next; setConnected(true); render();
      if (finished.length) {
        const formats = [...new Set(finished.map(j => formatLabel(j.format)))];
        toast(`${finished.length} ${formats.length === 1 ? formats[0] : 'files'} ready. Saved to output folder.`);
      }
    };
    eventSource.onerror = () => { setConnected(false); eventSource.close(); setTimeout(connect, 3000); };
  } catch { setConnected(false); setTimeout(connect, 3000); }
}
window.addEventListener('beforeunload', e => { if (uploading) { e.preventDefault(); e.returnValue = ''; } });
void connect();
