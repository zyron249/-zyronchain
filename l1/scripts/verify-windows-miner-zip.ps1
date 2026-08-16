$ErrorActionPreference = 'Stop'
$zip = Get-ChildItem -LiteralPath 'miner-release' -Filter 'ZyronMiner-windows-*.zip' | Select-Object -First 1
if (-not $zip) { throw 'missing Windows miner ZIP' }
$extract = Join-Path $env:RUNNER_TEMP 'zyron-miner-zip-smoke'
Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $zip.FullName -DestinationPath $extract
$launcher = Get-ChildItem -LiteralPath $extract -Filter 'ZyronMiner.cmd' -Recurse | Select-Object -First 1
if (-not $launcher) { throw 'Windows miner ZIP missing ZyronMiner.cmd' }
$node = Get-ChildItem -LiteralPath $extract -Filter 'node.exe' -Recurse | Select-Object -First 1
if (-not $node) { throw 'Windows miner ZIP missing bundled node.exe' }
Write-Host "Windows miner ZIP smoke: $($zip.Name) contains launcher and runtime"
