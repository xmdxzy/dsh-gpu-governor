# GPU governor process control: suspend or resume one process by PID.
#
# Output is a single JSON line so the host can report an exact outcome.
# Suspending freezes the process's GPU work (it yields SM time and the
# scheduler slot) but it does NOT release its VRAM: only termination does.
# The panel states that explicitly so "pause" is never mistaken for "free".
param(
    [Parameter(Mandatory = $true)][ValidateSet('suspend', 'resume')][string] $Action,
    [Parameter(Mandatory = $true)][int] $ProcessId
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$stdout = [Console]::OpenStandardOutput()
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Emit($ok, $message, $extra) {
    $payload = [ordered]@{ ok = $ok; action = $Action; pid = $ProcessId; message = $message }
    if ($extra) { foreach ($k in $extra.Keys) { $payload[$k] = $extra[$k] } }
    $bytes = $utf8.GetBytes((($payload | ConvertTo-Json -Compress -Depth 4) + "`n"))
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
    if ($ok) { exit 0 } else { exit 1 }
}

if ($ProcessId -le 8) {
    Emit $false "refusing to touch system PID $ProcessId"
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GpuGovernorNt {
    [DllImport("ntdll.dll", SetLastError = true)]
    public static extern int NtSuspendProcess(IntPtr processHandle);
    [DllImport("ntdll.dll", SetLastError = true)]
    public static extern int NtResumeProcess(IntPtr processHandle);
}
'@ -ErrorAction Stop

try {
    $target = Get-Process -Id $ProcessId -ErrorAction Stop
} catch {
    Emit $false "no such process"
}

# Windows exposes process control only through the native thread/fiber APIs, so
# the handle is opened with PROCESS_SUSPEND_RESUME access.
try {
    if ($Action -eq 'suspend') {
        $status = [GpuGovernorNt]::NtSuspendProcess($target.Handle)
    } else {
        $status = [GpuGovernorNt]::NtResumeProcess($target.Handle)
    }
} catch {
    Emit $false $_.Exception.Message
}

# NTSTATUS: 0 = success, 0xC0000022 = access denied (needs elevation).
if ($status -eq 0) {
    Emit $true "$Action ok" @{ processName = $target.ProcessName; status = $status }
} elseif ($status -eq -1073741790) {
    Emit $false "access denied: run DSH elevated to control this process" @{ processName = $target.ProcessName; status = $status }
} else {
    Emit $false ("NTSTATUS 0x{0:X8}" -f $status) @{ processName = $target.ProcessName; status = $status }
}
