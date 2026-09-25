export const outputFormats = [
  { id: 'mp3', label: 'MP3', ext: '.mp3', codec: 'libmp3lame', mime: 'audio/mpeg', qualities: [128, 192, 256, 320], defaultQuality: 192 },
  { id: 'aac', label: 'M4A (AAC)', shortLabel: 'M4A', ext: '.m4a', codec: 'aac', mime: 'audio/mp4', qualities: [96, 128, 192, 256], defaultQuality: 128 },
  { id: 'flac', label: 'FLAC', ext: '.flac', codec: 'flac', mime: 'audio/flac', qualities: [0, 5, 8, 12], defaultQuality: 5 },
  { id: 'wav', label: 'WAV', ext: '.wav', codec: 'pcm_s16le', mime: 'audio/wav', qualities: [16, 24], defaultQuality: 16 },
  { id: 'opus', label: 'Opus', shortLabel: 'OPUS', ext: '.opus', codec: 'libopus', mime: 'audio/ogg', qualities: [64, 96, 128, 160, 192], defaultQuality: 128 },
  { id: 'ogg', label: 'OGG Vorbis', shortLabel: 'OGG', ext: '.ogg', codec: 'libvorbis', mime: 'audio/ogg', qualities: [4, 5, 6, 8], defaultQuality: 5 }
];

export const extensions = new Set(['.m4a', '.aac', '.mp3', '.wav', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.alac', '.mp4', '.m4b', '.webm', '.mov', '.mkv', '.mka']);

export function safeName(name) {
  const filename = name.replace(/\\/g, '/').split('/').pop();
  let base = filename.replace(/\.[^.]*$/, '').normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100);
  if (!base) base = 'Track';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  return base;
}

export function settingsFrom(value = {}, { migrateLegacy = false } = {}) {
  const format = String(value.format || 'mp3');
  const formatInfo = outputFormats.find(f => f.id === format);
  if (!formatInfo) throw new Error('Invalid output format.');
  let quality = Number(value.quality ?? value.bitrate ?? formatInfo.defaultQuality);
  if (migrateLegacy && value.quality == null && value.bitrate != null && !formatInfo.qualities.includes(quality)) quality = formatInfo.defaultQuality;
  if (!formatInfo.qualities.includes(quality)) throw new Error('Invalid audio quality for selected format.');
  return { quality, cover: value.cover !== false, ascii: value.ascii === true, format };
}

export function outputBase(name, ascii) {
  const base = safeName(name);
  return ascii ? base.replace(/ı/g, 'i').replace(/İ/g, 'I').replace(/ş/g, 's').replace(/Ş/g, 'S')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'G').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 _().-]/g, '_') : base;
}

export function conversionArgs(input, output, info, settings, withCover = true, externalCover = null) {
  const formatId = settings.format || 'mp3';
  const formatInfo = getFormatInfo(formatId);
  const quality = Number(settings.quality ?? settings.bitrate ?? formatInfo.defaultQuality);
  const isMp3 = formatId === 'mp3';
  const picture = isMp3 && settings.cover && withCover && (externalCover || info.streams?.find(s => s.codec_type === 'video' && s.disposition?.attached_pic === 1));
  const args = ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', input];
  if (externalCover && picture) args.push('-i', externalCover);
  args.push('-map', '0:a:0');
  if (picture) args.push('-map', externalCover ? '1:v:0' : `0:${picture.index}`, '-c:v', 'mjpeg', '-filter:v', "scale=600:600:force_original_aspect_ratio=decrease", '-disposition:v:0', 'attached_pic', '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
  else args.push('-vn');
  
  if (isMp3) {
    args.push('-map_metadata', '0', '-map_chapters', '-1', '-c:a', 'libmp3lame', '-b:a', `${quality}k`, '-ar', '44100', '-ac', '2', '-id3v2_version', '3', '-write_id3v1', '1', '-f', 'mp3');
  } else if (formatId === 'wav') {
    args.push('-c:a', quality === 24 ? 'pcm_s24le' : 'pcm_s16le', '-ar', '44100', '-ac', '2', '-f', 'wav');
  } else if (formatId === 'flac') {
    args.push('-c:a', 'flac', '-compression_level', String(quality), '-ar', '44100', '-ac', '2', '-f', 'flac');
  } else if (formatId === 'ogg') {
    args.push('-c:a', 'libvorbis', '-q:a', String(quality), '-ar', '44100', '-ac', '2', '-f', 'ogg');
  } else if (formatId === 'aac') {
    args.push('-c:a', 'aac', '-b:a', `${quality}k`, '-ar', '44100', '-ac', '2', '-f', 'mp4');
  } else if (formatId === 'opus') {
    args.push('-c:a', 'libopus', '-b:a', `${quality}k`, '-vbr', 'on', '-application', 'audio', '-ar', '48000', '-ac', '2', '-f', 'opus');
  }

  args.push('-threads', '2', '-progress', 'pipe:1', '-nostats', output);
  return args;
}

export function getFormatInfo(formatId) {
  return outputFormats.find(f => f.id === formatId) || outputFormats[0];
}
