# Registers a hidden logon task that starts whisper-server for this user.
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\register-whisper-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\register-whisper-autostart.ps1 -Status
#   powershell -ExecutionPolicy Bypass -File .\scripts\register-whisper-autostart.ps1 -Remove
param(
  [switch]$Remove,
  [switch]$Status
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$taskName = "ParakeetWhisper"
$whisperScript = Join-Path $root "scripts\start-whisper.ps1"

if ($Status) {
  try {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Write-Host "Task '$taskName' is registered (state: $($task.State))."
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
    if ($info) {
      Write-Host "Last run: $($info.LastRunTime); last result: $($info.LastTaskResult)."
    }
  } catch {
    Write-Host "Task '$taskName' is not registered: $($_.Exception.Message)"
  }
  return
}

if ($Remove) {
  try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    Write-Host "Removed scheduled task '$taskName'."
  } catch {
    Write-Host "Task '$taskName' was not registered: $($_.Exception.Message)"
  }
  return
}

if (-not (Test-Path $whisperScript)) {
  Write-Host "Missing script: $whisperScript. Run scripts\setup-local.ps1 first."
  exit 1
}

$whisperTools = Join-Path $root "tools\whisper"
if (-not (Test-Path $whisperTools)) {
  Write-Warning "whisper tools not found at $whisperTools. Run scripts\setup-local.ps1 first; registering anyway."
}

try {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$whisperScript`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -RunLevel Limited -Force -ErrorAction Stop | Out-Null
  Write-Host "Registered '$taskName': whisper-server will start hidden at logon."
  Write-Host "Use -Status to query or -Remove to unregister."
} catch {
  Write-Host "Could not register '$taskName': $($_.Exception.Message)"
  exit 1
}
