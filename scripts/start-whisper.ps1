# Starts the local whisper.cpp server on http://127.0.0.1:8080/inference
param(
  [string]$Model = "ggml-large-v3-turbo-q5_0.bin",
  [int]$Port = 8080,
  [string]$Language = "en",
  [switch]$NoGpu
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$modelPath = Join-Path $root "tools\models\$Model"

if (-not (Test-Path $modelPath)) {
  throw "Model not found: $modelPath. Run scripts\setup-local.ps1 first."
}
if ((Get-Item $modelPath).Length -lt 500MB) {
  throw "Model looks incomplete: $modelPath. Re-run scripts\setup-local.ps1 to resume the download."
}

$server = Get-ChildItem -Path (Join-Path $root "tools\whisper") -Recurse -Filter "whisper-server.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $server) {
  throw "whisper-server.exe not found. Run scripts\setup-local.ps1 first."
}

$args = @("-m", $modelPath, "--host", "127.0.0.1", "--port", "$Port", "-l", $Language)
if ($NoGpu) { $args += "-ng" }

Write-Host "Serving $Model on 127.0.0.1:$Port (language: $Language, GPU: $(-not $NoGpu))"
& $server.FullName @args
