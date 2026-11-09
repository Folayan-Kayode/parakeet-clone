# Downloads a whisper.cpp Windows build (CUDA when available) and a turbo model.
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\setup-local.ps1
param(
  [string]$Model = "ggml-large-v3-turbo-q5_0.bin",
  [string]$ModelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
  [switch]$SkipModel
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root "tools"
$downloads = Join-Path $tools "downloads"
$whisperDir = Join-Path $tools "whisper"
$modelsDir = Join-Path $tools "models"
New-Item -ItemType Directory -Force -Path $downloads, $whisperDir, $modelsDir | Out-Null

Write-Host "Resolving latest whisper.cpp release with Windows binaries..."
$releases = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15" -Headers @{ "User-Agent" = "parakeet-clone-setup" }

$asset = $null
foreach ($release in $releases) {
  $cuda = $release.assets | Where-Object { $_.name -match '^whisper-bin-win-cuda-12[^/]*-x64\.zip$' } | Select-Object -First 1
  $cpu = $release.assets | Where-Object { $_.name -eq 'whisper-bin-x64.zip' } | Select-Object -First 1
  $candidate = if ($cuda) { $cuda } else { $cpu }
  if ($candidate) { $asset = $candidate; break }
}
if (-not $asset) { throw "No Windows x64 whisper.cpp binary found in recent releases." }
Write-Host "Downloading $($asset.name) ..."
$zip = Join-Path $downloads $asset.name
curl.exe -L --fail --retry 10 --retry-delay 3 --retry-all-errors -o $zip $asset.browser_download_url
if ($LASTEXITCODE -ne 0) { throw "Binary download failed (curl exit $LASTEXITCODE)." }
Write-Host "Extracting..."
Expand-Archive -Path $zip -DestinationPath $whisperDir -Force

if (-not $SkipModel) {
  $modelPath = Join-Path $modelsDir $Model
  $expected = 500MB
  if ((Test-Path $modelPath) -and ((Get-Item $modelPath).Length -gt $expected)) {
    Write-Host "Model already present: $modelPath"
  } else {
    Write-Host "Downloading model $Model (resumable, this can take a few minutes)..."
    curl.exe -L --fail --retry 20 --retry-delay 5 --retry-all-errors -C - -o $modelPath $ModelUrl
    if ($LASTEXITCODE -ne 0) { throw "Model download failed (curl exit $LASTEXITCODE). Re-run this script to resume." }
  }
}

$server = Get-ChildItem -Path $whisperDir -Recurse -Filter "whisper-server.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($server) {
  Write-Host ""
  Write-Host "whisper-server: $($server.FullName)"
  Write-Host "Start it with: powershell -ExecutionPolicy Bypass -File .\scripts\start-whisper.ps1"
} else {
  Write-Warning "whisper-server.exe was not found in the downloaded archive. Check the release contents."
}

Write-Host ""
Write-Host "Answers (Ollama):"
Write-Host "  winget install Ollama.Ollama"
Write-Host "  ollama pull qwen2.5vl:7b"
Write-Host "Then run the app: npm run dev"
