export const extensions = new Set(['.m4a', '.aac', '.mp3', '.wav', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.alac', '.mp4', '.m4b', '.webm']);

export function safeName(name) {
  const filename = name.replace(/\\/g, '/').split('/').pop();
  let base = filename.replace(/\.[^.]*$/, '').normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100);
  if (!base) base = 'Parça';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  return base;
}

export function settingsFrom(value = {}) {
  const bitrate = Number(value.bitrate ?? 192);
  if (![128, 192, 256, 320].includes(bitrate)) throw new Error('Geçersiz ses kalitesi.');
  return { bitrate, cover: value.cover !== false, ascii: value.ascii === true };
}

export function outputBase(name, ascii) {
  const base = safeName(name);
  return ascii ? base.replace(/ı/g, 'i').replace(/İ/g, 'I').replace(/ş/g, 's').replace(/Ş/g, 'S')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'G').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 _().-]/g, '_') : base;
}

export function conversionArgs(input, output, info, settings, withCover = true, externalCover = null) {
  const picture = settings.cover && withCover && (externalCover || info.streams?.find(s => s.codec_type === 'video' && s.disposition?.attached_pic === 1));
  const args = ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', input];
  if (externalCover && picture) args.push('-i', externalCover);
  args.push('-map', '0:a:0');
  if (picture) args.push('-map', externalCover ? '1:v:0' : `0:${picture.index}`, '-c:v', 'mjpeg', '-filter:v', "scale=600:600:force_original_aspect_ratio=decrease", '-disposition:v:0', 'attached_pic', '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
  else args.push('-vn');
  args.push('-map_metadata', '0', '-map_chapters', '-1', '-c:a', 'libmp3lame', '-b:a', `${settings.bitrate}k`, '-ar', '44100', '-ac', '2', '-id3v2_version', '3', '-write_id3v1', '1', '-threads', '2', '-progress', 'pipe:1', '-nostats', '-f', 'mp3', output);
  return args;
}
