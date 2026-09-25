import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ffmpegInstallerCommand, executableAvailable, resolveToolchain } from '../lib/platform.mjs';
import { installYouTube } from './install-youtube.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function runInstaller(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Installer exited with code ${code}.`)));
  });
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 22) throw new Error(`Node.js 22 or later is required; found ${process.versions.node}.`);
  let tools = resolveToolchain(root);
  if (process.env.FFMPEG_PATH && !executableAvailable(tools.ffmpeg)) throw new Error('FFMPEG_PATH does not point to an available executable.');
  if (process.env.FFPROBE_PATH && !executableAvailable(tools.ffprobe)) throw new Error('FFPROBE_PATH does not point to an available executable.');
  if (process.env.YTDLP_PATH && !executableAvailable(tools.ytdlp)) throw new Error('YTDLP_PATH does not point to an available executable.');
  if (!executableAvailable(tools.ffmpeg) || !executableAvailable(tools.ffprobe)) {
    console.log('FFmpeg is not available; starting platform setup...');
    const installer = ffmpegInstallerCommand(root);
    await runInstaller(installer.command, installer.args);
    tools = resolveToolchain(root);
  }
  if (!executableAvailable(tools.ffmpeg) || !executableAvailable(tools.ffprobe)) {
    throw new Error('FFmpeg or FFprobe is still unavailable. Set FFMPEG_PATH and FFPROBE_PATH, then try again.');
  }

  if (!executableAvailable(tools.ytdlp)) {
    console.log('yt-dlp is not available; downloading the verified official binary...');
    const installed = await installYouTube({ root });
    if (!executableAvailable(installed.target)) throw new Error('yt-dlp installation completed, but the executable could not be started.');
  }
  console.log('SoundWave setup is complete.');
}

main().catch(error => { console.error(`Setup failed: ${error.message}`); process.exitCode = 1; });
