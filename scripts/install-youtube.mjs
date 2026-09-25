import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { bundledToolPath } from '../lib/platform.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1024 * 1024;

function currentLibc() {
  if (process.platform !== 'linux') return '';
  return process.report?.getReport?.()?.header?.glibcVersionRuntime ? 'glibc' : 'musl';
}

export function youtubeReleaseAsset(platform = process.platform, arch = process.arch, libc = currentLibc()) {
  if (platform === 'win32') {
    if (arch === 'arm64') return 'yt-dlp_arm64.exe';
    if (arch === 'ia32') return 'yt-dlp_x86.exe';
    if (arch === 'x64') return 'yt-dlp.exe';
  }
  if (platform === 'darwin' && ['x64', 'arm64'].includes(arch)) return 'yt-dlp_macos';
  if (platform === 'linux') {
    if (arch === 'x64') return libc === 'musl' ? 'yt-dlp_musllinux' : 'yt-dlp_linux';
    if (arch === 'arm64') return libc === 'musl' ? 'yt-dlp_musllinux_aarch64' : 'yt-dlp_linux_aarch64';
  }
  throw new Error(`No supported yt-dlp binary is available for ${platform}/${arch}. Set YTDLP_PATH to a compatible installation.`);
}

async function responseFor(url, maxBytes) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'SoundWave/1.3' }, signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}.`);
  const host = new URL(response.url).hostname.toLowerCase();
  if (host !== 'github.com' && !host.endsWith('.githubusercontent.com')) throw new Error('Download was redirected outside the approved GitHub hosts.');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Downloaded file exceeds the safety limit.');
  return response;
}

async function downloadText(url) {
  const response = await responseFor(url, MAX_CHECKSUM_BYTES);
  let text = '', received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > MAX_CHECKSUM_BYTES) throw new Error('Checksum file exceeds the safety limit.');
    text += Buffer.from(chunk).toString('utf8');
  }
  return text;
}

async function downloadBinary(url, destination) {
  const response = await responseFor(url, MAX_BINARY_BYTES);
  const handle = await fs.open(destination, 'wx');
  const hash = createHash('sha256');
  let received = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      if (received > MAX_BINARY_BYTES) throw new Error('yt-dlp binary exceeds the safety limit.');
      hash.update(buffer);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
        if (!bytesWritten) throw new Error('Could not write yt-dlp binary.');
        offset += bytesWritten;
      }
    }
  } finally { await handle.close(); }
  return { sha256: hash.digest('hex'), finalUrl: response.url };
}

async function binaryVersion(binary) {
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], { windowsHide: true, timeout: 30000 });
    return stdout.trim();
  } catch { return ''; }
}

async function replaceFile(source, target) {
  const backup = `${target}.old`;
  await fs.rm(backup, { force: true });
  let movedOld = false;
  try {
    await fs.rename(target, backup);
    movedOld = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (movedOld) await fs.rename(backup, target).catch(() => {});
    throw error;
  }
  return { backup, movedOld };
}

export function checksumForAsset(text, asset) {
  const escapedAsset = asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^([a-fA-F0-9]{64})\\s+\\*?${escapedAsset}$`, 'm').exec(text);
  return match?.[1].toLowerCase() || '';
}

export async function installYouTube({ root = ROOT, platform = process.platform, arch = process.arch, libc = currentLibc(), update = false } = {}) {
  const asset = youtubeReleaseAsset(platform, arch, libc);
  const target = bundledToolPath(root, 'yt-dlp', platform);
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });
  const existingVersion = update ? '' : await binaryVersion(target);
  if (existingVersion) return { target, version: existingVersion, installed: false };

  const checksumText = await downloadText(`${RELEASE_BASE}/SHA2-256SUMS`);
  const expected = checksumForAsset(checksumText, asset);
  if (!expected) throw new Error(`SHA-256 checksum for ${asset} was not found in the official release.`);
  const temporary = `${target}.new-${process.pid}`;
  await fs.rm(temporary, { force: true });
  try {
    const downloaded = await downloadBinary(`${RELEASE_BASE}/${asset}`, temporary);
    if (downloaded.sha256 !== expected) throw new Error('yt-dlp SHA-256 verification failed; installation was aborted.');
    if (platform !== 'win32') await fs.chmod(temporary, 0o755);
    const replacement = await replaceFile(temporary, target);
    const version = await binaryVersion(target);
    if (!version) {
      await fs.rm(target, { force: true });
      if (replacement.movedOld) await fs.rename(replacement.backup, target).catch(() => {});
      throw new Error('The installed yt-dlp binary could not be started.');
    }
    await fs.rm(replacement.backup, { force: true });
    await fs.writeFile(path.join(directory, 'version.txt'), `${version}\n`, 'utf8');
    await fs.writeFile(path.join(directory, 'SOURCE.txt'), `Source: ${downloaded.finalUrl}\nSHA256: ${expected}\nLicense: https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE\n`, 'utf8');
    return { target, version, installed: true };
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  installYouTube({ update: process.argv.includes('--update') })
    .then(result => console.log(`YouTube engine is ready: ${result.version}`))
    .catch(error => { console.error(`YouTube engine installation failed: ${error.message}`); process.exitCode = 1; });
}
