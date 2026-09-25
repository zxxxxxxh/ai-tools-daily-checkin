# Register daily 10:10 check-in scheduled task (self-adaptive to this machine).
# Auto-detects local Node.js and writes node-path.txt so run-checkin.bat needs no edits.
# Idempotent; cleans up previously mis-registered garbled task names; ASCII-only.

# --- 0. auto-detect Node.js on this machine -----------------------------------
function Resolve-Node {
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) {
        $src = @($cmd.Source)[0]
        if ($src -match '\.exe$') { return $src }
    }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:APPDATA 'nvm\node.exe')
    )
    foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
    return $null
}

$dir = $PSScriptRoot
$node = Resolve-Node
if ($node) {
    Set-Content -Path (Join-Path $dir 'node-path.txt') -Value $node -Encoding ascii -NoNewline
    Write-Output ("Detected Node: " + $node)
} else {
    Write-Warning "Node.js not found. run-checkin.bat will still search PATH\/common paths; create node-path.txt manually if needed."
}

# --- 1. warn about (do NOT auto-delete) tasks with non-ASCII names -------------
# Legacy: an earlier mis-encoded registration created a garbled task name.
# We no longer auto-remove them to avoid deleting unrelated tasks on other PCs.
foreach ($t in (Get-ScheduledTask)) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($t.TaskName)
    $hasNonAscii = $false
    foreach ($b in $bytes) { if ($b -gt 127) { $hasNonAscii = $true; break } }
    if ($hasNonAscii) {
        Write-Warning ("Existing task with non-ASCII name (left unchanged): " + $t.TaskName)
    }
}

# --- 2. register scheduled task (runs as current user, daily 10:10) -----------
$action   = New-ScheduledTaskAction -Execute (Join-Path $dir 'run-checkin.bat') -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -Daily -At '10:10'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName 'AI-Daily-Checkin' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName 'AI-Daily-Checkin'
Write-Output ("Registered 'AI-Daily-Checkin'. Next run: " + $info.NextRunTime)