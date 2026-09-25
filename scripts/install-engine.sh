#!/usr/bin/env sh
set -eu

if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  echo "FFmpeg and FFprobe are already available."
  exit 0
fi

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "Administrator access is required. Install FFmpeg manually or run this script as root." >&2
    exit 1
  fi
}

case "$(uname -s)" in
  Darwin)
    if ! command -v brew >/dev/null 2>&1; then
      echo "Homebrew was not found. Install it from https://brew.sh and run this script again." >&2
      exit 1
    fi
    brew install ffmpeg
    ;;
  Linux)
    if command -v apt-get >/dev/null 2>&1; then
      run_as_root apt-get update
      run_as_root apt-get install -y ffmpeg
    elif command -v dnf >/dev/null 2>&1; then
      run_as_root dnf install -y ffmpeg
    elif command -v pacman >/dev/null 2>&1; then
      run_as_root pacman -S --needed --noconfirm ffmpeg
    elif command -v zypper >/dev/null 2>&1; then
      run_as_root zypper --non-interactive install ffmpeg
    elif command -v apk >/dev/null 2>&1; then
      run_as_root apk add ffmpeg
    else
      echo "No supported package manager was found. Install FFmpeg and FFprobe, then run SoundWave again." >&2
      exit 1
    fi
    ;;
  *)
    echo "Unsupported operating system. Set FFMPEG_PATH and FFPROBE_PATH manually." >&2
    exit 1
    ;;
esac

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "FFmpeg installation completed, but the commands are not available on PATH. Restart the terminal and try again." >&2
  exit 1
fi

echo "FFmpeg and FFprobe are ready."
