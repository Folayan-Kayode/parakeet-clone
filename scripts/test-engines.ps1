# Verifies the local Ollama chat endpoint and the whisper.cpp ASR endpoint.
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\test-engines.ps1
param(
  [string]$OllamaUrl = "http://127.0.0.1:11434/v1",
  [string]$WhisperUrl = "http://127.0.0.1:8080/inference",
  [string]$Model = "qwen2.5vl:7b"
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$samples = Join-Path $root "tools\samples"
New-Item -ItemType Directory -Force -Path $samples | Out-Null

Write-Host "=== Ollama chat test ($Model) ==="
$body = @{
  model       = $Model
  stream      = $false
  messages    = @(@{ role = "user"; content = "Reply with exactly: OK" })
  max_tokens  = 8
  temperature = 0
} | ConvertTo-Json -Depth 6
try {
  $res = Invoke-RestMethod -Uri "$OllamaUrl/chat/completions" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 180
  $text = $res.choices[0].message.content
  Write-Host "LLM OK -> $text"
} catch {
  Write-Warning "LLM test failed: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "=== whisper.cpp ASR test ==="
$sample = Join-Path $samples "jfk.wav"
if (-not (Test-Path $sample) -or (Get-Item $sample).Length -lt 100000) {
  Write-Host "Downloading sample audio..."
  curl.exe -L --fail --retry 5 --retry-all-errors -o $sample "https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav"
  if ($LASTEXITCODE -ne 0) { Write-Warning "Sample download failed." }
}

if (Test-Path $sample) {
  $raw = curl.exe -s --fail -F "file=@$sample" -F "response_format=json" -F "temperature=0" $WhisperUrl
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "ASR request failed. Is whisper-server running on port 8080?"
  } else {
    try {
      $json = $raw | ConvertFrom-Json
      Write-Host "ASR OK -> $($json.text)"
    } catch {
      Write-Host "ASR raw response -> $raw"
    }
  }
} else {
  Write-Warning "No sample audio available."
}
