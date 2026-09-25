import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  bundledToolPath,
  executableAvailable,
  ffmpegEncoderAvailable,
  ffmpegInstallerCommand,
  folderPickerCommand,
  openerCommand,
  processSpawnOptions,
  resolveToolPath,
  safeUploadBasename,
  toolFileName,
  youtubeFilenameArgs
} from '../lib/platform.mjs';
import { checksumForAsset, youtubeReleaseAsset } from '../scripts/install-youtube.mjs';

test('Tool names and bundled locations are platform-aware', () => {
  assert.equal(toolFileName('ffmpeg', 'win32'), 'ffmpeg.exe');
  assert.equal(toolFileName('ffmpeg', 'darwin'), 'ffmpeg');
  assert.match(bundledToolPath('/app', 'yt-dlp', 'linux').replaceAll('\\', '/'), /\/tools\/yt-dlp\/yt-dlp$/);
  assert.match(bundledToolPath('C:\\app', 'ffprobe', 'win32'), /ffprobe\.exe$/);
});

test('Tool resolution prefers explicit, bundled, then PATH executables', () => {
  const root = path.resolve('project');
  assert.equal(resolveToolPath(root, 'ffmpeg', { env: { FFMPEG_PATH: '/custom/ffmpeg' }, exists: () => false, available: () => false }), '/custom/ffmpeg');
  const bundled = bundledToolPath(root, 'ffmpeg', 'linux');
  assert.equal(resolveToolPath(root, 'ffmpeg', { platform: 'linux', env: {}, exists: value => value === bundled, available: () => false }), bundled);
  assert.equal(resolveToolPath(root, 'ffmpeg', { platform: 'linux', env: {}, exists: () => false, available: value => value === 'ffmpeg' }), 'ffmpeg');
  assert.equal(resolveToolPath(root, 'ffmpeg', { platform: 'linux', env: {}, exists: () => false, available: () => false }), bundled);
});

test('PATH tool checks use the version flag expected by each executable', () => {
  const calls = [];
  const spawnSyncImpl = (command, args) => { calls.push({ command, args }); return { status: 0 }; };
  assert.equal(executableAvailable('ffmpeg', { spawnSyncImpl }), true);
  assert.equal(executableAvailable('ffprobe', { spawnSyncImpl }), true);
  assert.equal(executableAvailable('yt-dlp', { spawnSyncImpl }), true);
  assert.deepEqual(calls, [
    { command: 'ffmpeg', args: ['-version'] },
    { command: 'ffprobe', args: ['-version'] },
    { command: 'yt-dlp', args: ['--version'] }
  ]);
});

test('FFmpeg encoder detection handles bundled and native codec lists', () => {
  const withVorbis = () => ({ status: 0, stdout: ' A..... libvorbis            libVorbis (codec vorbis)\n A..X.. vorbis               Vorbis' });
  assert.equal(ffmpegEncoderAvailable('/tools/ffmpeg', 'libvorbis', { spawnSyncImpl: withVorbis }), true);
  assert.equal(ffmpegEncoderAvailable('/tools/ffmpeg', 'vorbis', { spawnSyncImpl: withVorbis }), true);
  assert.equal(ffmpegEncoderAvailable('/tools/ffmpeg', 'aac', { spawnSyncImpl: withVorbis }), false);
  assert.equal(ffmpegEncoderAvailable('/tools/ffmpeg', 'libvorbis', { spawnSyncImpl: () => ({ status: 1, stderr: 'failed' }) }), false);
});

test('Upload names are safe across Windows and POSIX clients', () => {
  assert.equal(safeUploadBasename('C:\\fakepath\\song.m4a'), 'song.m4a');
  assert.equal(safeUploadBasename('/Users/test/song.m4a'), 'song.m4a');
  assert.equal(safeUploadBasename('../../song.m4a'), 'song.m4a');
});

test('Desktop integration commands cover Windows, macOS, and Linux', () => {
  assert.deepEqual(openerCommand('C:\\Music', { platform: 'win32' }), { command: 'explorer.exe', args: ['C:\\Music'] });
  assert.deepEqual(openerCommand('/Music', { platform: 'darwin' }), { command: 'open', args: ['/Music'] });
  assert.deepEqual(openerCommand('/Music', { platform: 'linux', available: command => command === 'xdg-open' }), { command: 'xdg-open', args: ['/Music'] });
  assert.equal(folderPickerCommand('/app', { platform: 'win32' }).command, 'powershell.exe');
  assert.equal(folderPickerCommand('/app', { platform: 'darwin' }).command, 'osascript');
  assert.equal(folderPickerCommand('/app', { platform: 'linux', available: command => command === 'zenity' }).command, 'zenity');
  assert.throws(() => folderPickerCommand('/app', { platform: 'linux', available: () => false }), /Zenity|KDialog/);
});

test('Process, filename, installer and yt-dlp release choices are portable', () => {
  assert.equal(processSpawnOptions('win32').detached, false);
  assert.equal(processSpawnOptions('linux').detached, true);
  assert.deepEqual(youtubeFilenameArgs('win32'), ['--windows-filenames']);
  assert.deepEqual(youtubeFilenameArgs('darwin'), []);
  assert.equal(ffmpegInstallerCommand('/app', 'darwin').command, 'sh');
  assert.equal(ffmpegInstallerCommand('/app', 'linux').command, 'sh');
  assert.equal(ffmpegInstallerCommand('C:\\app', 'win32').command, 'powershell.exe');
  assert.equal(youtubeReleaseAsset('win32', 'x64'), 'yt-dlp.exe');
  assert.equal(youtubeReleaseAsset('win32', 'arm64'), 'yt-dlp_arm64.exe');
  assert.equal(youtubeReleaseAsset('darwin', 'arm64'), 'yt-dlp_macos');
  assert.equal(youtubeReleaseAsset('linux', 'x64', 'glibc'), 'yt-dlp_linux');
  assert.equal(youtubeReleaseAsset('linux', 'arm64', 'glibc'), 'yt-dlp_linux_aarch64');
  assert.equal(youtubeReleaseAsset('linux', 'x64', 'musl'), 'yt-dlp_musllinux');
  assert.equal(youtubeReleaseAsset('linux', 'arm64', 'musl'), 'yt-dlp_musllinux_aarch64');
  assert.throws(() => youtubeReleaseAsset('linux', 'riscv64'), /YTDLP_PATH/);
  const checksum = 'a'.repeat(64);
  assert.equal(checksumForAsset(`${checksum}  yt-dlp_macos\n`, 'yt-dlp_macos'), checksum);
  assert.equal(checksumForAsset(`${checksum}  yt-dlp_macos\n`, 'yt-dlp.exe'), '');
});
