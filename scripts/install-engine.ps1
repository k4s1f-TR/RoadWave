$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = Split-Path -Parent $PSScriptRoot
$engineDir = Join-Path $projectRoot 'tools\ffmpeg'
if ((Test-Path -LiteralPath (Join-Path $engineDir 'ffmpeg.exe')) -and (Test-Path -LiteralPath (Join-Path $engineDir 'ffprobe.exe'))) {
    Write-Output 'FFmpeg engine is ready.'
    exit 0
}
$downloadDir = Join-Path $projectRoot '.engine-downloads'
New-Item -ItemType Directory -Force -Path $downloadDir, $engineDir | Out-Null
$archive = Join-Path $downloadDir 'ffmpeg-release-essentials.zip'
$checksumFile = Join-Path $downloadDir 'ffmpeg-release-essentials.zip.sha256'
$baseUrl = 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip'
Write-Output 'Downloading FFmpeg Windows engine (approx. 110 MB)...'
& curl.exe --fail --location --silent --show-error --connect-timeout 20 --max-time 60 --output $checksumFile ($baseUrl + '.sha256')
if ($LASTEXITCODE -ne 0) { throw 'Failed to download FFmpeg verification checksum.' }
$expected = ((Get-Content -LiteralPath $checksumFile -Raw).Trim() -split '\s+')[0]
if ($expected -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid SHA256 checksum.' }
$downloadNeeded = $true
if (Test-Path -LiteralPath $archive) { $downloadNeeded = ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) }
if ($downloadNeeded) {
    & curl.exe --fail --location --silent --show-error --continue-at - --connect-timeout 20 --max-time 900 --output $archive $baseUrl
    if ($LASTEXITCODE -ne 0) { throw 'Failed to download FFmpeg. The download will resume when restarted.' }
}
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or $actual -ne $expected) { throw 'FFmpeg SHA256 verification failed. Installation aborted.' }
Write-Output 'Download verified. Extracting engine...'
$unpackDir = Join-Path $downloadDir ('unpacked-' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $archive -DestinationPath $unpackDir
$binary = Get-ChildItem -LiteralPath $unpackDir -Filter ffmpeg.exe -Recurse | Select-Object -First 1
if (-not $binary) { throw 'FFmpeg binary not found in archive.' }
Copy-Item -LiteralPath $binary.FullName -Destination (Join-Path $engineDir 'ffmpeg.exe')
Copy-Item -LiteralPath (Join-Path $binary.DirectoryName 'ffprobe.exe') -Destination (Join-Path $engineDir 'ffprobe.exe')
$packageDir = Split-Path -Parent $binary.DirectoryName
Get-ChildItem -LiteralPath $packageDir -File | Where-Object { $_.Name -match 'LICENSE|README' } | Copy-Item -Destination $engineDir
Set-Content -LiteralPath (Join-Path $engineDir 'SOURCE.txt') -Value "Source: $baseUrl`r`nSHA256: $actual`r`nInstalled: $(Get-Date -Format o)" -Encoding UTF8
Write-Output 'FFmpeg and FFprobe are ready.'
