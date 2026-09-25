import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ENV_NAMES = { ffmpeg: 'FFMPEG_PATH', ffprobe: 'FFPROBE_PATH', 'yt-dlp': 'YTDLP_PATH' };

export function toolFileName(tool, platform = process.platform) {
  return platform === 'win32' ? `${tool}.exe` : tool;
}

export function bundledToolPath(root, tool, platform = process.platform) {
  const directory = tool === 'yt-dlp' ? 'yt-dlp' : 'ffmpeg';
  return path.join(root, 'tools', directory, toolFileName(tool, platform));
}

function isPathLike(value) {
  return path.isAbsolute(value) || value.includes('/') || value.includes('\\');
}

export function executableAvailable(command, { exists = fs.existsSync, spawnSyncImpl = spawnSync } = {}) {
  if (!command) return false;
  if (isPathLike(command)) return exists(command);
  const result = spawnSyncImpl(command, ['--version'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
  return !result.error && result.status === 0;
}

export function resolveToolPath(root, tool, {
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
  available = executableAvailable
} = {}) {
  const configured = env[ENV_NAMES[tool]];
  if (configured) return configured;
  const bundled = bundledToolPath(root, tool, platform);
  if (exists(bundled)) return bundled;
  if (available(tool)) return tool;
  return bundled;
}

export function resolveToolchain(root, options = {}) {
  return {
    ffmpeg: resolveToolPath(root, 'ffmpeg', options),
    ffprobe: resolveToolPath(root, 'ffprobe', options),
    ytdlp: resolveToolPath(root, 'yt-dlp', options)
  };
}

export function safeUploadBasename(value) {
  const name = path.posix.basename(String(value || '').replaceAll('\\', '/'));
  return name === '.' || name === '..' ? '' : name;
}

export function processSpawnOptions(platform = process.platform) {
  return { windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] };
}

export function youtubeFilenameArgs(platform = process.platform) {
  return platform === 'win32' ? ['--windows-filenames'] : [];
}

export function openerCommand(target, { platform = process.platform, available = executableAvailable } = {}) {
  if (platform === 'win32') return { command: 'explorer.exe', args: [target] };
  if (platform === 'darwin') return { command: 'open', args: [target] };
  if (platform === 'linux' && available('xdg-open')) return { command: 'xdg-open', args: [target] };
  if (platform === 'linux' && available('gio')) return { command: 'gio', args: ['open', target] };
  throw new Error('No desktop opener was found. Install xdg-utils or open the path manually.');
}

export function folderPickerCommand(root, { platform = process.platform, available = executableAvailable, initial = '' } = {}) {
  if (platform === 'win32') {
    return { command: 'powershell.exe', args: ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/select-folder.ps1')], cancelCodes: [] };
  }
  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: ['-e', 'try', '-e', 'POSIX path of (choose folder with prompt "Choose an output folder for SoundWave")', '-e', 'on error number -128', '-e', 'return ""', '-e', 'end try'],
      cancelCodes: []
    };
  }
  if (platform === 'linux' && available('zenity')) {
    const args = ['--file-selection', '--directory', '--title=Choose an output folder for SoundWave'];
    if (initial) args.push(`--filename=${path.resolve(initial)}${path.sep}`);
    return { command: 'zenity', args, cancelCodes: [1] };
  }
  if (platform === 'linux' && available('kdialog')) {
    return { command: 'kdialog', args: ['--getexistingdirectory', initial || '.'], cancelCodes: [1] };
  }
  throw new Error('No folder picker was found. Install Zenity or KDialog, or set SOUNDWAVE_OUTPUT before starting SoundWave.');
}

export function youtubeInstallerCommand(root) {
  return { command: process.execPath, args: [path.join(root, 'scripts/install-youtube.mjs'), '--update'] };
}

export function ffmpegInstallerCommand(root, platform = process.platform) {
  if (platform === 'win32') {
    return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/install-engine.ps1')] };
  }
  if (platform === 'darwin' || platform === 'linux') {
    return { command: 'sh', args: [path.join(root, 'scripts/install-engine.sh')] };
  }
  throw new Error(`Automatic FFmpeg setup is not supported on ${platform}. Set FFMPEG_PATH and FFPROBE_PATH manually.`);
}

export function platformName(platform = process.platform) {
  return { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[platform] || platform;
}
