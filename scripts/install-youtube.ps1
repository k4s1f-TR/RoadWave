param([switch]$Update)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$arguments = @((Join-Path $PSScriptRoot 'install-youtube.mjs'))
if ($Update) { $arguments += '--update' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw 'YouTube engine installation failed.' }
