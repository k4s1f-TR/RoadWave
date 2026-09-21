param([switch]$Update)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$engineDir = Join-Path $projectRoot 'tools\yt-dlp'
$target = Join-Path $engineDir 'yt-dlp.exe'
if ((Test-Path -LiteralPath $target) -and -not $Update) { Write-Output 'YouTube motoru hazir.'; exit 0 }
$downloadDir = Join-Path $projectRoot '.youtube-downloads'
New-Item -ItemType Directory -Force -Path $downloadDir, $engineDir | Out-Null
function Download-File($url, $destination) {
    & curl.exe --fail --location --silent --show-error --connect-timeout 20 --max-time 300 --retry 2 --output $destination $url
    if ($LASTEXITCODE -ne 0) { throw 'YouTube motoru indirilemedi. Internet baglantisini kontrol edin.' }
}
Write-Output 'Resmi yt-dlp surumu kontrol ediliyor...'
$releaseFile = Join-Path $downloadDir 'release.json'
Download-File 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest' $releaseFile
$release = Get-Content -LiteralPath $releaseFile -Raw | ConvertFrom-Json
$binary = $release.assets | Where-Object { $_.name -eq 'yt-dlp.exe' } | Select-Object -First 1
$checksum = $release.assets | Where-Object { $_.name -eq 'SHA2-256SUMS' } | Select-Object -First 1
if (-not $binary -or -not $checksum) { throw 'Resmi surum dosyalari bulunamadi.' }
$archive = Join-Path $downloadDir 'yt-dlp.exe'
$sums = Join-Path $downloadDir 'SHA2-256SUMS'
Download-File $binary.browser_download_url $archive
Download-File $checksum.browser_download_url $sums
$line = Get-Content -LiteralPath $sums | Where-Object { $_ -match '^([a-fA-F0-9]{64})\s+\*?yt-dlp\.exe$' } | Select-Object -First 1
if (-not $line) { throw 'SHA256 dogrulama bilgisi bulunamadi.' }
$expected = ($line -split '\s+')[0]
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'SHA256 dogrulamasi basarisiz; motor kurulmadı.' }
Copy-Item -LiteralPath $archive -Destination ($target + '.new') -Force
Move-Item -LiteralPath ($target + '.new') -Destination $target -Force
Set-Content -LiteralPath (Join-Path $engineDir 'version.txt') -Value $release.tag_name -Encoding UTF8
Set-Content -LiteralPath (Join-Path $engineDir 'SOURCE.txt') -Value "Source: $($binary.browser_download_url)`r`nSHA256: $expected`r`nLicenses: https://github.com/yt-dlp/yt-dlp/blob/master/THIRD_PARTY_LICENSES.txt" -Encoding UTF8
Write-Output ('YouTube motoru hazir: ' + $release.tag_name)
