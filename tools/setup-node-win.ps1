$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeLock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-lock.json') -Raw | ConvertFrom-Json
$version = $runtimeLock.node.version
$artifact = $runtimeLock.node.'windows-x64'
$runtimePath = Join-Path $PSScriptRoot "node-v$version-win-x64"
$archivePath = Join-Path $PSScriptRoot "node-v$version-win-x64.zip"
if (Test-Path -LiteralPath $runtimePath) { throw "El runtime ya existe: $runtimePath. No se reemplaza automáticamente." }
Invoke-WebRequest -UseBasicParsing -Uri $artifact.url -OutFile $archivePath
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLower()
if ($actualHash -ne $artifact.sha256) { throw 'SHA Node incorrecto: no se extrajo ni ejecutó.' }
Expand-Archive -LiteralPath $archivePath -DestinationPath $PSScriptRoot
Write-Output "Runtime local verificado: $runtimePath\node.exe"
