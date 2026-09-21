const $ = selector => document.querySelector(selector);
let state = { jobs: [], settings: {} }, token = '', filter = 'all', uploading = false, connected = false;
let eventSource, lastJobRender = '', settingsBusy = false;
let intentionallyStopped = false;
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const size = value => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
const duration = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
function toast(message, error = false) {
  const el = document.createElement('div'); el.className = `toast${error ? ' error' : ''}`;
  const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label', 'Bildirimi kapat'); close.onclick = () => el.remove();
  el.append(close, document.createTextNode(message)); $('#toast-stack').append(el);
  setTimeout(() => el.remove(), error ? 12000 : 5000);
}
async function api(url, data = {}) {
  const res = await fetch(`/api/${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Roadwave-Token': token }, body: JSON.stringify(data) });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error || 'İşlem tamamlanamadı.');
  return value;
}
function safeAction(fn) { return async (...args) => { try { await fn(...args); } catch (error) { toast(error.message, true); } }; }
function setConnected(value) {
  connected = value;
  $('#connection').classList.toggle('offline', !value);
  $('#connection').innerHTML = `<i></i>${value ? 'Yerel motor bağlı' : 'Bağlantı bekleniyor'}`;
  updateStart();
  window.dispatchEvent(new CustomEvent('roadwave-state'));
}
function updateStart() {
  const ready = state.jobs.filter(j => j.status === 'ready').length;
  $('#start-button').disabled = !ready || !connected || !state.engineReady || settingsBusy || uploading;
  $('#start-button span').textContent = ready ? `${ready} dosyayı MP3’e dönüştür` : 'MP3’e dönüştür';
  $('#start-hint').textContent = uploading ? 'Dosyalar ekleniyor…' : ready ? 'Yerel işlem · Orijinal dosyalar korunur' : state.active ? 'Dönüştürme devam ediyor…' : 'Başlamak için ses dosyası ekle';
}
function render() {
  const jobs = state.jobs, done = jobs.filter(j => j.status === 'done').length;
  $('#queue-count').textContent = jobs.length;
  $('#done-count').textContent = done;
  $('#queue-summary').textContent = jobs.length ? `${jobs.length} parça · ${duration(jobs.reduce((a, j) => a + j.duration, 0))} toplam süre${done ? ` · ${done} tamamlandı` : ''}` : 'Biraz müzik ekleyerek başlayalım.';
  $('#total-size').textContent = size(jobs.reduce((a, j) => a + j.size, 0));
  $('#clear-done').disabled = !done;
  const running = jobs.filter(j => ['queued', 'converting'].includes(j.status)).length;
  $('#cancel-all').classList.toggle('hidden', !running);
  $('#queue-footer-text').textContent = running ? `${running} dosya işleniyor · ${state.active} aktif` : done ? `${done} MP3 yola hazır` : 'Dönüştürmeye hazır';
  $('#engine-warning').classList.toggle('hidden', state.engineReady);
  const visible = filter === 'done' ? jobs.filter(j => j.status === 'done') : jobs;
  $('#empty-state').classList.toggle('hidden', visible.length > 0);
  $('#empty-state strong').textContent = filter === 'done' ? 'Tamamlanan parçalar burada görünecek.' : 'Güzel bir yolculuk, iyi müzikle başlar.';
  const rows = visible.map(job => {
    const meta = [size(job.size), duration(job.duration), job.hasCover ? 'Kapak var' : 'Kapak yok'];
    const status = { ready: 'Dönüştürmeye hazır', queued: 'Sırada bekliyor', converting: `Dönüştürülüyor · %${job.progress}`, done: `MP3 hazır · ${job.bitrate} kbps · ${size(job.outputSize || 0)}`, error: job.error, canceled: 'Durduruldu' }[job.status];
    const button = (action, name, label) => `<button class="icon-button" data-action="${action}" data-id="${job.id}" aria-label="${escape(label)}" title="${escape(label)}">${icon(name)}</button>`;
    let actions = '';
    if (job.status === 'done') actions = button('play', 'play', 'Ön dinle') + `<a class="icon-button" href="/api/audio/${job.id}?download" title="MP3 indir" aria-label="MP3 indir">${icon('download')}</a>` + button('folder', 'folder', 'Dosyanın klasörünü aç');
    if (['error', 'canceled'].includes(job.status)) actions += button('retry', 'refresh', 'Yeniden dene');
    if (['queued', 'converting'].includes(job.status)) actions += button('cancel', 'close', 'Dönüştürmeyi durdur');
    else actions += button('remove', 'close', 'Listeden kaldır; MP3 dosyasını koru');
    return `<article class="job-row" data-job="${job.id}"><div class="file-icon">${icon('music')}<small>${escape(job.name.split('.').pop().toUpperCase())}</small></div><div class="file-main"><span class="file-title" title="${escape(job.name)}">${escape(job.name)}</span><div class="file-meta">${meta.map(escape).join('<span>·</span>')}</div><div class="file-status ${job.status}">${escape(status)}</div>${job.warning ? `<div class="file-status file-warning">${escape(job.warning)}</div>` : ''}${job.status === 'converting' ? `<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${job.progress}" aria-label="Dönüştürme ilerlemesi"><span style="width:${job.progress}%"></span></div>` : ''}</div><div class="job-actions">${actions}</div></article>`;
  }).join('');
  if (rows !== lastJobRender) {
    const focused = document.activeElement?.dataset;
    $('#job-list').innerHTML = rows; lastJobRender = rows;
    if (focused?.action && focused.id) $(`[data-action="${focused.action}"][data-id="${focused.id}"]`)?.focus({ preventScroll: true });
  }
  $('#output-path').textContent = state.settings.outputDir || 'outputs';
  $('#output-path-button').title = state.settings.outputDir || 'Çıktı klasörünü aç';
  if (!settingsBusy) {
    document.querySelectorAll('[data-bitrate]').forEach(el => el.classList.toggle('active', Number(el.dataset.bitrate) === state.settings.bitrate));
    $('#quality-label').textContent = { 128: 'Kompakt', 192: 'Dengeli', 256: 'Yüksek', 320: 'En yüksek bit hızı' }[state.settings.bitrate];
    $('#cover-toggle').checked = state.settings.cover;
    $('#ascii-toggle').checked = state.settings.ascii;
    $('#parallel').value = state.settings.parallel;
  }
  updateStart();
}
async function saveSettings(change) {
  if (settingsBusy) return;
  settingsBusy = true; updateStart();
  document.querySelectorAll('[data-bitrate], #cover-toggle, #ascii-toggle, #parallel').forEach(el => el.disabled = true);
  try { state.settings = await api('settings', { ...state.settings, ...change }); }
  finally {
    settingsBusy = false;
    document.querySelectorAll('[data-bitrate], #cover-toggle, #ascii-toggle, #parallel').forEach(el => el.disabled = false);
    render();
  }
}
const pendingFiles = [];
function uploadFile(file, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('X-Roadwave-Token', token);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => progress(e.lengthComputable ? Math.round(e.loaded / e.total * 100) : 0);
    xhr.onload = () => {
      try { const data = JSON.parse(xhr.responseText); xhr.status < 300 ? resolve(data) : reject(new Error(data.error)); }
      catch { reject(new Error('Sunucudan yanıt alınamadı.')); }
    };
    xhr.onerror = () => reject(new Error('Yerel sunucuya bağlanılamadı. Başlat penceresinin açık olduğunu kontrol et.'));
    xhr.send(file);
  });
}
async function addFiles(files) {
  if (!connected) return toast('Önce yerel sunucu bağlantısını kontrol et.', true);
  const supported = /\.(m4a|aac|mp3|wav|flac|ogg|opus|wma|aiff?|alac|mp4|m4b|webm)$/i;
  for (const file of files) {
    if (!supported.test(file.name)) { toast(`${file.name}: desteklenmeyen dosya türü.`, true); continue; }
    if (state.jobs.some(j => j.name === file.name && j.size === file.size && !['error', 'canceled'].includes(j.status)) || pendingFiles.some(f => f.name === file.name && f.size === file.size)) {
      toast(`${file.name} zaten listede.`); continue;
    }
    pendingFiles.push(file);
  }
  if (uploading || !pendingFiles.length) return;
  uploading = true; updateStart(); $('#upload-status').classList.remove('hidden');
  let added = 0;
  while (pendingFiles.length) {
    const file = pendingFiles.shift();
    try {
      await uploadFile(file, value => { $('#upload-status').textContent = `${file.name} · ${value === 100 ? 'Ses bilgileri okunuyor…' : `%${value} yerel kopyalanıyor`}${pendingFiles.length ? ` · ${pendingFiles.length} sırada` : ''}`; });
      added++;
    } catch (error) { toast(`${file.name}: ${error.message}`, true); }
  }
  uploading = false; $('#upload-status').classList.add('hidden'); updateStart();
  if (added) toast(`${added} dosya dönüştürme kuyruğuna eklendi.`);
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
document.querySelectorAll('[data-bitrate]').forEach(el => el.onclick = safeAction(() => saveSettings({ bitrate: Number(el.dataset.bitrate) })));
$('#cover-toggle').onchange = safeAction(e => saveSettings({ cover: e.target.checked }));
$('#ascii-toggle').onchange = safeAction(e => saveSettings({ ascii: e.target.checked }));
$('#parallel').onchange = safeAction(e => saveSettings({ parallel: Number(e.target.value) }));
$('#choose-folder').onclick = safeAction(async () => {
  $('#choose-folder').disabled = true; $('#choose-folder').textContent = 'Pencere açık…';
  try { await api('folder'); } finally { $('#choose-folder').disabled = false; $('#choose-folder').textContent = 'Değiştir'; }
});
$('#start-button').onclick = safeAction(async () => { $('#start-button').disabled = true; try { await api('start'); } finally { updateStart(); } });
$('#cancel-all').onclick = safeAction(() => api('cancel'));
$('#shutdown-button').onclick = safeAction(async () => {
  if (uploading) return toast('Dosyaların eklenmesini bekle.', true);
  await api('shutdown'); intentionallyStopped = true; eventSource?.close();
  setConnected(false); $('#connection').innerHTML = '<i></i> Uygulama kapalı';
  $('#shutdown-button').disabled = true;
  toast('Roadwave kapatıldı. Yeniden açmak için Baslat.cmd dosyasına çift tıkla.');
});
$('#clear-done').onclick = safeAction(async () => { await api('remove', { completed: true }); toast('Tamamlananlar listeden kaldırıldı. MP3 dosyaların korunuyor.'); });
for (const selector of ['#nav-output', '#output-path-button']) $(selector).onclick = safeAction(() => api('open-folder'));
for (const selector of ['#nav-guide', '#usb-tip']) $(selector).onclick = () => $('#guide-dialog').showModal();
$('#nav-convert').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
document.querySelectorAll('[data-close]').forEach(el => el.onclick = () => document.getElementById(el.dataset.close).close());
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', e => { if (e.target === dialog) { const rect = dialog.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close(); } }));
$('#player-dialog').addEventListener('close', () => $('#audio-player').pause());
$('#audio-player').addEventListener('error', () => toast('MP3 açılamadı. Dosya taşınmış, silinmiş veya sürücü çıkarılmış olabilir.', true));
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
    const response = await fetch('/api/state'); if (!response.ok) throw new Error('Bağlantı yok');
    state = await response.json(); token = state.token; render(); setConnected(true);
    eventSource?.close(); eventSource = new EventSource('/api/events');
    eventSource.onmessage = e => {
      const next = JSON.parse(e.data);
      const finished = next.jobs.filter(j => j.status === 'done' && state.jobs.some(old => old.id === j.id && old.status === 'converting'));
      state = next; setConnected(true); render();
      if (finished.length) toast(`${finished.length} MP3 hazır. Çıktı klasörüne kaydedildi.`);
    };
    eventSource.onerror = () => { setConnected(false); eventSource.close(); setTimeout(connect, 3000); };
  } catch { setConnected(false); setTimeout(connect, 3000); }
}
window.addEventListener('beforeunload', e => { if (uploading) { e.preventDefault(); e.returnValue = ''; } });
void connect();
