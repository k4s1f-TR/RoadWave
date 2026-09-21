(() => {
  let preview = null, selected = new Set(), shown = 100, format = 'mp3', inspecting = false, submitting = false, updateBusy = false, lastRows = '';
  const originals = { heading: $('.intro h1').innerHTML, subtitle: $('.intro p').textContent, eyebrow: $('.intro .eyebrow').innerHTML };
  let previousJobs = null;
  function view(youtube) {
    $('#converter-panel').classList.toggle('hidden', youtube); $('#youtube-panel').classList.toggle('hidden', !youtube);
    document.body.classList.toggle('yt-only-view', youtube);
    $('#nav-convert').classList.toggle('selected', !youtube); $('#nav-youtube').classList.toggle('selected', youtube);
    $('.topbar strong').textContent = youtube ? 'YouTube indirici' : 'Dönüştürücü';
    $('.intro h1').innerHTML = youtube ? 'Favorilerini yanında taşı<span>.</span><br>Ses ya da video, sen seç.' : originals.heading;
    $('.intro p').textContent = youtube ? 'Bir video veya bir playlist. Kendi kütüphanene, tek yerden.' : originals.subtitle;
    $('.intro .eyebrow').innerHTML = youtube ? '<span></span> KÜTÜPHANEN GENİŞLİYOR.' : originals.eyebrow;
    history.replaceState(null, '', youtube ? '#youtube' : location.pathname);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  $('#nav-youtube').onclick = () => view(true);
  $('#nav-convert').onclick = () => view(false);
  function showError(message) { $('#yt-error').textContent = message || ''; $('#yt-error').classList.toggle('hidden', !message); }
  function options() { return { format, bitrate: Number($('#yt-bitrate').value), resolution: Number($('#yt-resolution').value), cover: $('#yt-cover').checked, ascii: $('#yt-ascii').checked }; }
  function remember() { try { localStorage.setItem('roadwave-youtube-options', JSON.stringify(options())); } catch {} }
  function chooseFormat(value) {
    format = value === 'mp4' ? 'mp4' : 'mp3';
    document.querySelectorAll('[data-yt-format]').forEach(b => b.classList.toggle('active', b.dataset.ytFormat === format));
    $('#yt-audio-options').classList.toggle('hidden', format !== 'mp3'); $('#yt-video-options').classList.toggle('hidden', format !== 'mp4');
    selectionState(); remember();
  }
  function selectionState() {
    const available = preview?.entries.filter(e => e.available) || [];
    $('#yt-select-all').checked = Boolean(available.length) && available.every(e => selected.has(e.id));
    $('#yt-select-all').indeterminate = selected.size > 0 && !$('#yt-select-all').checked;
    $('#yt-selection-count').textContent = `${selected.size} seçildi`;
    $('#yt-enqueue span').textContent = submitting ? 'Kuyruğa ekleniyor…' : `${selected.size} ${format.toUpperCase()} indir`;
    $('#yt-enqueue').disabled = !selected.size || submitting || !connected || !state.youtube?.ready || state.youtube?.updating;
  }
  function drawPreview() {
    $('#yt-preview').classList.toggle('hidden', !preview); if (!preview) return;
    $('#yt-preview-title').textContent = preview.title;
    const unavailable = preview.entries.filter(e => !e.available).length;
    $('#yt-preview-summary').textContent = `${preview.kind === 'playlist' ? 'Oynatma listesi' : 'Tek video'} · ${preview.entries.length} içerik${unavailable ? ` · ${unavailable} içerik indirilemiyor` : ''}`;
    $('#yt-preview-list').innerHTML = preview.entries.slice(0, shown).map(e => `<label class="yt-preview-row${e.available ? '' : ' unavailable'}"><input type="checkbox" data-yt-entry="${escape(e.id)}" ${selected.has(e.id) ? 'checked' : ''} ${e.available ? '' : 'disabled'} aria-label="${escape(e.title)}"><span class="yt-preview-index">${e.index}</span><span class="yt-preview-text"><strong title="${escape(e.title)}">${escape(e.title)}</strong><small>${escape(e.available ? e.author || 'YouTube' : 'Özel, silinmiş veya canlı içerik')}</small></span><span>${e.duration ? duration(e.duration) : '—'}</span></label>`).join('');
    $('#yt-show-more').classList.toggle('hidden', shown >= preview.entries.length); selectionState();
  }
  function renderYouTube() {
    const yt = state.youtube || { jobs: [], ready: false };
    const jobs = yt.jobs || [], busy = yt.active || 0, done = jobs.filter(j => j.status === 'done').length;
    $('#yt-count').textContent = jobs.length;
    $('#yt-summary').textContent = jobs.length ? `${done} tamamlandı · ${jobs.filter(j => j.status === 'queued').length} sırada · ${jobs.filter(j => j.status === 'error').length} hata` : 'Favorilerin için yeni bir yer.';
    $('#yt-empty').classList.toggle('hidden', jobs.length > 0);
    $('#yt-clear').disabled = !done || !connected;
    $('#yt-cancel-all').classList.toggle('hidden', !busy && !jobs.some(j => j.status === 'queued'));
    $('#yt-queue-status').textContent = busy ? `${busy} aktif işlem · Aynı anda en fazla 2 indirme` : done ? `${done} dosya kütüphanene kaydedildi` : 'İndirme bekleniyor';
    $('#yt-engine-status').textContent = yt.updating || updateBusy ? 'Motor indiriliyor / güncelleniyor…' : yt.ready ? `yt-dlp ${yt.version || ''} · Hazır` : 'Motor kurulumu gerekli';
    $('#yt-update').disabled = Boolean(yt.updating || updateBusy || busy || inspecting || yt.inspecting || !connected);
    $('#yt-inspect').disabled = Boolean(!connected || !yt.ready || yt.updating || inspecting || yt.inspecting);
    $('#yt-inspect-status').classList.toggle('hidden', !inspecting && !yt.inspecting);
    $('#yt-output-path').textContent = state.settings.outputDir || 'outputs'; $('#yt-output-folder').title = state.settings.outputDir || '';
    const rows = jobs.map(job => {
      const button = (action, name, label) => `<button class="icon-button" data-yt-action="${action}" data-id="${job.id}" aria-label="${label}" title="${label}">${icon(name)}</button>`;
      let actions = '';
      if (job.status === 'done') actions = button('play', 'play', 'Dosyayı önizle') + `<a class="icon-button" href="/api/audio/${job.id}?download" title="Dosyayı indir" aria-label="Dosyayı indir">${icon('download')}</a>` + button('folder', 'folder', 'Klasörde göster');
      if (['error', 'canceled'].includes(job.status)) actions += button('retry', 'refresh', 'Yeniden dene');
      if (['downloading', 'processing', 'queued'].includes(job.status)) actions += button('cancel', 'close', 'İndirmeyi durdur');
      else if (job.status !== 'saving') actions += button('remove', 'close', 'Listeden kaldır');
      const statuses = { queued: 'Sırada bekliyor', downloading: `İndiriliyor · %${job.progress}${job.speed ? ` · ${size(job.speed)}/sn` : ''}${job.eta ? ` · ${duration(job.eta)} kaldı` : ''}`, processing: `${job.format.toUpperCase()} hazırlanıyor · %${job.progress}`, saving: 'Dosya kaydediliyor…', done: `${job.format.toUpperCase()} hazır · ${size(job.outputSize || 0)}`, canceled: 'Durduruldu · Yeniden deneyebilirsin', error: job.error };
      const quality = job.format === 'mp3' ? `${job.bitrate} kbps` : job.actualHeight ? `${job.actualHeight}p` : `En fazla ${job.resolution}p`;
      return `<article class="job-row"><div class="file-icon">${icon(job.format === 'mp4' ? 'play' : 'music')}<small>${job.format.toUpperCase()}</small></div><div class="file-main"><span class="file-title" title="${escape(job.title)}">${escape(job.title)}</span><div class="file-meta">${escape(quality)} · ${job.duration ? duration(job.duration) : 'YouTube'}${job.playlist ? ` · #${job.index}` : ''}</div><div class="file-status ${job.status}">${escape(statuses[job.status])}</div>${job.warning ? `<div class="file-status file-warning">${escape(job.warning)}</div>` : ''}${['downloading', 'processing'].includes(job.status) ? `<div class="progress-track" role="progressbar" aria-label="İndirme ilerlemesi" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${job.progress}"><span style="width:${job.progress}%"></span></div>` : ''}</div><div class="job-actions">${actions}</div></article>`;
    }).join('');
    if (rows !== lastRows) {
      const focused = document.activeElement?.dataset;
      $('#yt-jobs').innerHTML = rows; lastRows = rows;
      if (focused?.ytAction && focused.id) $(`[data-yt-action="${focused.ytAction}"][data-id="${focused.id}"]`)?.focus({ preventScroll: true });
    }
    if (previousJobs) {
      const completed = jobs.filter(j => j.status === 'done' && previousJobs.has(j.id) && previousJobs.get(j.id) !== 'done');
      if (completed.length) toast(`${completed.length} YouTube indirmesi tamamlandı.`);
    }
    previousJobs = new Map(jobs.map(j => [j.id, j.status])); selectionState();
  }
  $('#yt-form').onsubmit = async event => {
    event.preventDefault(); if (inspecting) return;
    inspecting = true; showError(''); preview = null; selected.clear(); drawPreview(); renderYouTube();
    try {
      preview = await api('youtube/inspect', { url: $('#yt-url').value, scope: $('input[name="yt-scope"]:checked').value });
      selected = new Set(preview.entries.filter(e => e.available).map(e => e.id)); shown = 100; drawPreview();
    } catch (error) { showError(error.message); }
    finally { inspecting = false; renderYouTube(); }
  };
  $('#yt-cancel-inspect').onclick = safeAction(() => api('youtube/cancel-inspect'));
  $('#yt-preview-list').onchange = event => { const id = event.target.dataset.ytEntry; if (!id) return; event.target.checked ? selected.add(id) : selected.delete(id); selectionState(); };
  $('#yt-select-all').onchange = event => { selected = new Set(event.target.checked ? preview.entries.filter(e => e.available).map(e => e.id) : []); drawPreview(); };
  $('#yt-show-more').onclick = () => { shown += 100; drawPreview(); };
  $('#yt-enqueue').onclick = async () => {
    if (!preview || submitting) return; submitting = true; selectionState(); showError('');
    try {
      const result = await api('youtube/enqueue', { previewId: preview.id, ids: [...selected], ...options() });
      toast(`${result.added} indirme kuyruğa eklendi.${result.skipped ? ` ${result.skipped} içerik aynı ayarla zaten eklenmiş.` : ''}`);
    } catch (error) { showError(error.message); } finally { submitting = false; selectionState(); }
  };
  document.querySelectorAll('[data-yt-format]').forEach(button => button.onclick = () => chooseFormat(button.dataset.ytFormat));
  for (const selector of ['#yt-bitrate', '#yt-resolution', '#yt-cover', '#yt-ascii']) $(selector).onchange = remember;
  $('#yt-choose-folder').onclick = safeAction(async () => { $('#yt-choose-folder').disabled = true; try { await api('folder'); } finally { $('#yt-choose-folder').disabled = false; } });
  $('#yt-output-folder').onclick = safeAction(() => api('open-folder'));
  $('#yt-cancel-all').onclick = safeAction(() => api('youtube/cancel'));
  $('#yt-clear').onclick = safeAction(async () => { await api('youtube/remove', { completed: true }); toast('Liste temizlendi. İndirilen dosyaların korunuyor.'); });
  $('#yt-update').onclick = async () => {
    updateBusy = true; renderYouTube(); showError('');
    try { await api('youtube/update'); toast('YouTube motoru güncellendi.'); }
    catch (error) { showError(error.message); } finally { updateBusy = false; renderYouTube(); }
  };
  $('#yt-jobs').onclick = safeAction(async event => {
    const button = event.target.closest('[data-yt-action]'); if (!button) return;
    const { ytAction: action, id } = button.dataset;
    if (action === 'play') {
      const job = state.youtube.jobs.find(j => j.id === id);
      $('#yt-player-title').textContent = job.title;
      const video = $('#yt-video-player'), audio = $('#yt-audio-player');
      video.classList.toggle('hidden', job.format !== 'mp4'); audio.classList.toggle('hidden', job.format !== 'mp3');
      const player = job.format === 'mp4' ? video : audio;
      player.src = `/api/audio/${id}`; $('#yt-player-dialog').showModal(); await player.play().catch(() => {});
    } else if (action === 'folder') await api('open-folder', { id });
    else await api(`youtube/${action}`, { id });
  });
  $('#yt-player-close').onclick = () => $('#yt-player-dialog').close();
  $('#yt-player-dialog').addEventListener('close', () => { $('#yt-video-player').pause(); $('#yt-audio-player').pause(); });
  for (const selector of ['#yt-video-player', '#yt-audio-player']) $(selector).addEventListener('error', () => toast('Dosya açılamadı. Taşınmış veya silinmiş olabilir.', true));
  try {
    const saved = JSON.parse(localStorage.getItem('roadwave-youtube-options') || '{}');
    if ([128, 192, 256, 320].includes(saved.bitrate)) $('#yt-bitrate').value = saved.bitrate;
    if ([360, 480, 720, 1080, 1440, 2160].includes(saved.resolution)) $('#yt-resolution').value = saved.resolution;
    if (typeof saved.cover === 'boolean') $('#yt-cover').checked = saved.cover;
    if (typeof saved.ascii === 'boolean') $('#yt-ascii').checked = saved.ascii;
    chooseFormat(saved.format);
  } catch { chooseFormat('mp3'); }
  window.addEventListener('roadwave-state', renderYouTube); renderYouTube();
  if (location.hash === '#youtube') view(true);
})();
