# Daily launcher: ensures whisper-server is running, then starts the app.
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\run-app.ps1
param(
  [string]$Model = "ggml-large-v3-turbo-q5_0.bin",
  [int]$WhisperPort = 8080,
  [switch]$NoWhisper
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot

# Ollama's OpenAI-compatible endpoint cannot set num_ctx per request. Raise the
# server default so the system prompt, résumé and screenshot image tokens are
# not silently truncated from the front. 16384 covers a long transcript plus
# context and one 1600x900 screenshot. Only affects Ollama started below.
$env:OLLAMA_CONTEXT_LENGTH = '16384'

function Test-Url([string]$url) {
  try { Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing | Out-Null; return $true } catch { return $false }
}

Write-Host "Checking Ollama..."
if (-not (Test-Url "http://127.0.0.1:11434/api/version")) {
  $ollama = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
  if (Test-Path $ollama) {
    Write-Host "Starting Ollama..."
    Start-Process -FilePath $ollama -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 3
  } else {
    Write-Warning "Ollama not installed. Answers will fail until it is running."
  }
}

if (-not $NoWhisper) {
  if (-not (Test-Url "http://127.0.0.1:$WhisperPort/inference")) {
    $server = Get-ChildItem -Path (Join-Path $root "tools\whisper") -Recurse -Filter "whisper-server.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    $modelPath = Join-Path $root "tools\models\$Model"
    if ($server -and (Test-Path $modelPath)) {
      Write-Host "Starting whisper-server..."
      Start-Process -FilePath $server.FullName -ArgumentList @("-m", $modelPath, "--host", "127.0.0.1", "--port", "$WhisperPort", "-l", "en") -WorkingDirectory $server.DirectoryName -WindowStyle Minimized
      Start-Sleep -Seconds 5
    } else {
      Write-Warning "whisper-server or model missing. Run scripts\setup-local.ps1 first, or use a paid STT endpoint in Settings."
    }
  } else {
    Write-Host "whisper-server already running."
  }
}

Write-Host "Starting app..."
Set-Location $root
npm run dev
