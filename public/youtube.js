(() => {
  let preview = null, selected = new Set(), shown = 100, format = 'mp3', inspecting = false, submitting = false, updateBusy = false, lastRows = '';
  const originals = { heading: $('.intro h1').innerHTML, subtitle: $('.intro p').textContent, eyebrow: $('.intro .eyebrow').innerHTML };
  let previousJobs = null;
  function view(downloader) {
    $('#converter-panel').classList.toggle('hidden', downloader); $('#youtube-panel').classList.toggle('hidden', !downloader);
    document.body.classList.toggle('yt-only-view', downloader);
    $('#nav-convert').classList.toggle('selected', !downloader); $('#nav-youtube').classList.toggle('selected', downloader);
    $('.topbar strong').textContent = downloader ? 'Downloader' : 'Converter';
    $('.intro h1').innerHTML = downloader ? 'Carry your favorites<span>.</span><br>YouTube, one place.' : originals.heading;
    $('.intro p').textContent = downloader ? 'A video, Short, or playlist. To your library, instantly.' : originals.subtitle;
    $('.intro .eyebrow').innerHTML = downloader ? '<span></span> MEDIA DOWNLOADER.' : originals.eyebrow;
    history.replaceState(null, '', downloader ? '#downloader' : location.pathname);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  $('#nav-youtube').onclick = () => view(true);
  $('#nav-convert').onclick = () => view(false);
  function showError(message) { $('#yt-error').textContent = message || ''; $('#yt-error').classList.toggle('hidden', !message); }
  function options() { return { format, bitrate: Number($('#yt-bitrate').value), resolution: Number($('#yt-resolution').value), cover: $('#yt-cover').checked, ascii: $('#yt-ascii').checked }; }
  function remember() { try { localStorage.setItem('soundwave-youtube-options', JSON.stringify(options())); } catch {} }
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
    $('#yt-selection-count').textContent = `${selected.size} selected`;
    $('#yt-enqueue span').textContent = submitting ? 'Enqueueing...' : `Download ${selected.size} ${format.toUpperCase()}`;
    $('#yt-enqueue').disabled = !selected.size || submitting || !connected || !state.youtube?.ready || state.youtube?.updating;
  }
  function drawPreview() {
    $('#yt-preview').classList.toggle('hidden', !preview); if (!preview) return;
    $('#yt-preview-title').textContent = preview.title;
    document.querySelector('[data-yt-format="mp4"]')?.classList.remove('hidden');
    const unavailable = preview.entries.filter(e => !e.available).length;
    const kindLabel = preview.kind === 'playlist' ? 'Playlist' : 'Single video';
    $('#yt-preview-summary').textContent = `YouTube · ${kindLabel} · ${preview.entries.length} content${unavailable ? ` · ${unavailable} content unavailable` : ''}`;
    $('#yt-preview-list').innerHTML = preview.entries.slice(0, shown).map(e => `<label class="yt-preview-row${e.available ? '' : ' unavailable'}"><input type="checkbox" data-yt-entry="${escape(e.id)}" ${selected.has(e.id) ? 'checked' : ''} ${e.available ? '' : 'disabled'} aria-label="${escape(e.title)}"><span class="yt-preview-index">${e.index}</span><span class="yt-preview-text"><strong title="${escape(e.title)}">${escape(e.title)}</strong><small>${escape(e.author || 'YouTube')}</small></span><span>${e.duration ? duration(e.duration) : '—'}</span></label>`).join('');
    $('#yt-show-more').classList.toggle('hidden', shown >= preview.entries.length); selectionState();
  }
  function renderYouTube() {
    const yt = state.youtube || { jobs: [], ready: false };
    const jobs = yt.jobs || [], busy = yt.active || 0, done = jobs.filter(j => j.status === 'done').length;
    $('#yt-count').textContent = jobs.length;
    $('#yt-summary').textContent = jobs.length ? `${done} completed · ${jobs.filter(j => j.status === 'queued').length} in queue · ${jobs.filter(j => j.status === 'error').length} errors` : 'A new place for your favorites.';
    $('#yt-empty').classList.toggle('hidden', jobs.length > 0);
    $('#yt-clear').disabled = !done || !connected;
    $('#yt-cancel-all').classList.toggle('hidden', !busy && !jobs.some(j => j.status === 'queued'));
    $('#yt-queue-status').textContent = busy ? `${busy} active · Max 2 simultaneous downloads` : done ? `${done} files saved to library` : 'Waiting for download';
    $('#yt-engine-status').textContent = yt.updating || updateBusy ? 'Engine downloading / updating…' : yt.ready ? `yt-dlp ${yt.version || ''} · Ready` : 'Engine setup required';
    $('#yt-update').disabled = Boolean(yt.updating || updateBusy || busy || inspecting || yt.inspecting || !connected);
    $('#yt-inspect').disabled = Boolean(!connected || !yt.ready || yt.updating || inspecting || yt.inspecting);
    $('#yt-inspect-status').classList.toggle('hidden', !inspecting && !yt.inspecting);
    $('#yt-output-path').textContent = state.settings.outputDir || 'outputs'; $('#yt-output-folder').title = state.settings.outputDir || '';
    const rows = jobs.map(job => {
      const button = (action, name, label) => `<button class="icon-button" data-yt-action="${action}" data-id="${job.id}" aria-label="${label}" title="${label}">${icon(name)}</button>`;
      let actions = '';
      if (job.status === 'done') actions = button('play', 'play', 'Preview file') + `<a class="icon-button" href="/api/audio/${job.id}?download" title="Download file" aria-label="Download file">${icon('download')}</a>` + button('folder', 'folder', 'Show in folder');
      if (['error', 'canceled'].includes(job.status)) actions += button('retry', 'refresh', 'Retry');
      if (['downloading', 'processing', 'queued'].includes(job.status)) actions += button('cancel', 'close', 'Stop download');
      else if (job.status !== 'saving') actions += button('remove', 'close', 'Remove from list');
      const statuses = { queued: 'Waiting in queue', downloading: `Downloading · ${job.progress}%` + (job.speed ? ` · ${size(job.speed)}/s` : '') + (job.eta ? ` · ${duration(job.eta)} left` : ''), processing: `Preparing ${job.format.toUpperCase()} · ${job.progress}%`, saving: 'Saving file…', done: `${job.format.toUpperCase()} ready · ${size(job.outputSize || 0)}`, canceled: 'Stopped · You can retry', error: job.error };
      const quality = job.format === 'mp3' ? `${job.bitrate} kbps` : job.actualHeight ? `${job.actualHeight}p` : `Up to ${job.resolution}p`;
      return `<article class="job-row"><div class="file-icon">${icon(job.format === 'mp4' ? 'play' : 'music')}<small>${job.format.toUpperCase()}</small></div><div class="file-main"><span class="file-title" title="${escape(job.title)}">${escape(job.title)}</span><div class="file-meta">YouTube · ${escape(quality)}${job.duration ? ` · ${duration(job.duration)}` : ''}${job.playlist ? ` · #${job.index}` : ''}</div><div class="file-status ${job.status}">${escape(statuses[job.status])}</div>${job.warning ? `<div class="file-status file-warning">${escape(job.warning)}</div>` : ''}${['downloading', 'processing'].includes(job.status) ? `<div class="progress-track" role="progressbar" aria-label="Download progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${job.progress}"><span style="width:${job.progress}%"></span></div>` : ''}</div><div class="job-actions">${actions}</div></article>`;
    }).join('');
    if (rows !== lastRows) {
      const focused = document.activeElement?.dataset;
      $('#yt-jobs').innerHTML = rows; lastRows = rows;
      if (focused?.ytAction && focused.id) $(`[data-yt-action="${focused.ytAction}"][data-id="${focused.id}"]`)?.focus({ preventScroll: true });
    }
    if (previousJobs) {
      const completed = jobs.filter(j => j.status === 'done' && previousJobs.has(j.id) && previousJobs.get(j.id) !== 'done');
      if (completed.length) toast(`${completed.length} downloads completed.`);
    }
    previousJobs = new Map(jobs.map(j => [j.id, j.status])); selectionState();
  }
  window.renderYouTube = renderYouTube;
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
      toast(`${result.added} downloads added to queue.` + (result.skipped ? ` ${result.skipped} content already added with same settings.` : ''));
    } catch (error) { showError(error.message); } finally { submitting = false; selectionState(); }
  };
  document.querySelectorAll('[data-yt-format]').forEach(button => button.onclick = () => chooseFormat(button.dataset.ytFormat));
  for (const selector of ['#yt-bitrate', '#yt-resolution', '#yt-cover', '#yt-ascii']) $(selector).onchange = remember;
  $('#yt-choose-folder').onclick = safeAction(async () => { $('#yt-choose-folder').disabled = true; try { await api('folder'); } finally { $('#yt-choose-folder').disabled = false; } });
  $('#yt-output-folder').onclick = safeAction(() => api('open-folder'));
  $('#yt-cancel-all').onclick = safeAction(() => api('youtube/cancel'));
  $('#yt-clear').onclick = safeAction(async () => { await api('youtube/remove', { completed: true }); toast('List cleared. Downloaded files are kept.'); });
  $('#yt-update').onclick = async () => {
    updateBusy = true; renderYouTube(); showError('');
    try { await api('youtube/update'); toast('YouTube engine updated.'); }
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
  for (const selector of ['#yt-video-player', '#yt-audio-player']) $(selector).addEventListener('error', () => toast('File could not be opened. It may have been moved or deleted.', true));
  try {
    const saved = JSON.parse(localStorage.getItem('soundwave-youtube-options') || '{}');
    if ([128, 192, 256, 320].includes(saved.bitrate)) $('#yt-bitrate').value = saved.bitrate;
    if ([360, 480, 720, 1080, 1440, 2160].includes(saved.resolution)) $('#yt-resolution').value = saved.resolution;
    if (typeof saved.cover === 'boolean') $('#yt-cover').checked = saved.cover;
    if (typeof saved.ascii === 'boolean') $('#yt-ascii').checked = saved.ascii;
    chooseFormat(saved.format);
  } catch { chooseFormat('mp3'); }
  window.addEventListener('soundwave-state', renderYouTube); renderYouTube();
  if (['#downloader', '#youtube'].includes(location.hash)) view(true);
})();
