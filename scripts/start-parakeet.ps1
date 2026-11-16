# One-click daily launcher: starts whisper-server only when port 8080 is closed,
# then launches the installed app (or falls back to dev mode in this repo).
# Usage: powershell -ExecutionPolicy Bypass -File .\scripts\start-parakeet.ps1
#        powershell -ExecutionPolicy Bypass -File .\scripts\start-parakeet.ps1 -CreateShortcut
param(
  [string]$AppExe = "",
  [switch]$CreateShortcut,
  [int]$WhisperPort = 8080
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot

function Test-TcpPort([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($pending)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Find-AppExe {
  $dirs = @(
    (Join-Path $env:LOCALAPPDATA "Programs\parakeet-clone"),
    (Join-Path $env:LOCALAPPDATA "Programs\Parakeet Clone")
  )
  if (${env:ProgramFiles}) {
    $dirs += Join-Path ${env:ProgramFiles} "parakeet-clone"
    $dirs += Join-Path ${env:ProgramFiles} "Parakeet Clone"
  }
  if (${env:ProgramFiles(x86)}) {
    $dirs += Join-Path ${env:ProgramFiles(x86)} "parakeet-clone"
    $dirs += Join-Path ${env:ProgramFiles(x86)} "Parakeet Clone"
  }
  foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) { continue }
    $exe = Get-ChildItem -Path $dir -Filter "*.exe" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notlike "Uninstall*" } |
      Select-Object -First 1
    if ($exe) { return $exe.FullName }
  }
  return $null
}

if ($CreateShortcut) {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $lnkPath = Join-Path $desktop "Parakeet (full start).lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($lnkPath)
  $shortcut.TargetPath = "powershell.exe"
  $shortcut.Arguments = "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $shortcut.WorkingDirectory = $root
  $shortcut.Description = "Start whisper-server if needed, then Parakeet Clone"
  $shortcut.Save()
  Write-Host "Created desktop shortcut: $lnkPath"
}

if (-not $AppExe) { $AppExe = Find-AppExe }
if ($AppExe -and -not (Test-Path $AppExe)) {
  Write-Warning "App executable not found at $AppExe; will use dev mode."
  $AppExe = $null
}

Write-Host "Checking whisper-server on port $WhisperPort..."
if (Test-TcpPort $WhisperPort) {
  Write-Host "whisper-server is already listening - skipping start."
} else {
  $startWhisper = Join-Path $root "scripts\start-whisper.ps1"
  if (-not (Test-Path $startWhisper)) {
    Write-Warning "Missing $startWhisper. Run scripts\setup-local.ps1 first."
  } else {
    Write-Host "Starting whisper-server (minimized)..."
    Start-Process -FilePath "powershell.exe" `
      -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$startWhisper`"", "-Port", "$WhisperPort") `
      -WindowStyle Minimized
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-TcpPort $WhisperPort) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
    }
    if (Test-TcpPort $WhisperPort) {
      Write-Host "whisper-server is ready."
    } else {
      Write-Warning "whisper-server did not open port $WhisperPort within 60s; starting the app anyway."
    }
  }
}

if ($AppExe) {
  Write-Host "Launching $AppExe"
  Start-Process -FilePath $AppExe
} else {
  Write-Warning "Installed app not found. Falling back to 'npm run dev' in $root."
  Set-Location $root
  npm run dev
}
