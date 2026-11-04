# GPU + CPU governor collector: one JSON line per sample on stdout.
#
# Windows WDDM hides per-process VRAM from nvidia-smi (used_gpu_memory = [N/A]),
# so per-PID numbers come from the GPU performance-counter WMI classes, which
# the driver keeps per process and per adapter:
#   Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -> DedicatedUsage
#   Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine        -> UtilizationPercentage
#
# Alternatives measured and rejected on this box:
#   Get-Counter  -> re-enumerates all instances per call, blocked 6-14s per sample
#   typeperf     -> 1.6-3.4s per sample (process start + 1s rate interval)
#
# CPU side uses two cheap sources, both measured on this box (72 logical CPUs):
#   Win32_Process (lean property list, no CommandLine)  ~340ms  -> per-process
#       CPU deltas from KernelModeTime+UserModeTime (100ns ticks) and WorkingSet
#   Win32_PerfFormattedData_PerfOS_Processor             ~280ms  -> total + per-core
#   Win32_OperatingSystem                                ~30ms   -> RAM free/total
# The instantaneous Percent*Time of PerfProc_Process costs ~640ms and can exceed
# 100% per process; deltas against a known wall clock are both cheaper and exact.
#
# Steady-state cost here: memory ~25ms, engine ~330-1500ms (720 instances),
# Win32_Process ~340ms, Win32_OperatingSystem ~30ms. Those are too heavy for a 3s
# cadence, so the engine class refreshes every EngineEvery rounds, the per-core
# class every OsCpuEvery rounds, the RAM query every MemEvery rounds, and the
# process table (with command lines) is cached for ProcInfoEvery rounds with an
# on-demand lookup for PIDs that appeared since.
param(
    [int] $IntervalMs = 4000,
    [int] $EngineEvery = 3,
    [int] $ProcInfoEvery = 15,
    [int] $OsCpuEvery = 2,
    [int] $MemEvery = 5,
    [int] $ParentPid = 0,
    [string] $PidFile = ''
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# Writing raw UTF-8 bytes to the standard handle keeps Chinese paths intact
# even when the parent redirects stdout under a legacy code page.
$stdout = [Console]::OpenStandardOutput()
$utf8 = [System.Text.UTF8Encoding]::new($false)

# Liveness guard. A plugin reload can leave an older collector orphaned, and a
# crashed Host leaves one behind too; both would keep sampling a 24GB card
# every few seconds forever. Two defences:
#   1. a pid file: a fresh collector retires any collector already running
#   2. parent liveness: exit as soon as the Host process disappears
$stateDir = Join-Path $env:USERPROFILE '.dsh\gpu-governor'
# A test harness passes its own pid file so a probe run cannot retire the live one.
if ([string]::IsNullOrWhiteSpace($PidFile)) { $pidFile = Join-Path $stateDir 'collector.pid' } else { $pidFile = $PidFile }
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $pidFile) -Force | Out-Null

function Test-IsCollectorProcess([int] $candidate) {
    if ($candidate -le 0 -or $candidate -eq $PID) { return $false }
    $row = Get-CimInstance Win32_Process -Filter "ProcessId=$candidate" -Property ProcessId, CommandLine -ErrorAction SilentlyContinue
    if ($null -eq $row) { return $false }
    return ($row.CommandLine -ne $null -and $row.CommandLine -match 'collector\.ps1')
}

try {
    if (Test-Path $pidFile) {
        $previous = (Get-Content $pidFile -TotalCount 1).Trim()
        if ($previous -match '^\d+$' -and (Test-IsCollectorProcess ([int]$previous))) {
            Stop-Process -Id ([int]$previous) -Force -ErrorAction SilentlyContinue
        }
    }
} catch {
    # An unreadable or stale pid file is not fatal.
}
Set-Content -Path $pidFile -Value $PID -Encoding Ascii

# Two collectors can start within the same second (a reload, or several Host
# plugin instances), each retiring the one it saw. Settle it by ownership: only
# the process whose PID survived in the file keeps running.
Start-Sleep -Milliseconds 1500
try {
    if ((Get-Content $pidFile -TotalCount 1).Trim() -ne [string]$PID) { exit 0 }
} catch {
    # A missing pid file means another collector already retired this one.
    exit 0
}

$memClass = 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory'
$engineClass = 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine'
$osCpuClass = 'Win32_PerfFormattedData_PerfOS_Processor'

# Static topology: 72 logical CPUs is what makes a per-process delta meaningful.
$coreCount = 1
try {
    $system = Get-CimInstance Win32_ComputerSystem -Property NumberOfLogicalProcessors -ErrorAction SilentlyContinue
    if ($system -and [int]$system.NumberOfLogicalProcessors -gt 0) { $coreCount = [int]$system.NumberOfLogicalProcessors }
} catch {
    $coreCount = [Environment]::ProcessorCount
}
if ($coreCount -le 0) { $coreCount = 1 }

# Board-level numbers the counters do not expose (name, total, temp, power).
function Read-Smi {
    $out = @()
    $raw = & nvidia-smi --query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits 2>$null
    foreach ($line in @($raw)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $p = $line -split ','
        if ($p.Count -lt 7) { continue }
        $out += [ordered]@{
            index    = [int]($p[0].Trim())
            name     = $p[1].Trim()
            memTotal = [long]($p[2].Trim())
            memUsed  = [long]($p[3].Trim())
            util     = [int]($p[4].Trim())
            tempC    = [int]($p[5].Trim())
            powerW   = [double]($p[6].Trim())
        }
    }
    return $out
}

# pid -> dedicated VRAM bytes, summed across that process's adapter instances.
function Read-ProcessVram {
    $map = @{}
    $rows = Get-CimInstance -ClassName $memClass -ErrorAction SilentlyContinue
    foreach ($row in $rows) {
        if ($row.Name -notmatch '^pid_(\d+)_') { continue }
        $procId = [int]$Matches[1]
        if ($procId -le 0) { continue }
        $bytes = [long]$row.DedicatedUsage
        if ($map.ContainsKey($procId)) { $map[$procId] += $bytes } else { $map[$procId] = $bytes }
    }
    return $map
}

# pid -> engine utilisation, summed across engines and capped at 100 by the host.
function Read-ProcessUtil {
    $map = @{}
    $rows = Get-CimInstance -ClassName $engineClass -ErrorAction SilentlyContinue
    foreach ($row in $rows) {
        if ($row.Name -notmatch '^pid_(\d+)_') { continue }
        $procId = [int]$Matches[1]
        if ($procId -le 0) { continue }
        $value = [double]$row.UtilizationPercentage
        if ($value -le 0) { continue }
        if ($map.ContainsKey($procId)) { $map[$procId] += $value } else { $map[$procId] = $value }
    }
    return $map
}

function Read-ProcessInfo {
    $table = @{}
    $rows = Get-CimInstance Win32_Process -Property ProcessId, Name, ExecutablePath, CommandLine -ErrorAction SilentlyContinue
    foreach ($row in $rows) {
        $cmd = $row.CommandLine
        if ($cmd -ne $null -and $cmd.Length -gt 512) { $cmd = $cmd.Substring(0, 512) }
        $table[[int]$row.ProcessId] = [ordered]@{
            name = [string]$row.Name
            exe  = [string]$row.ExecutablePath
            cmd  = [string]$cmd
        }
    }
    return $table
}

# Human-facing product name for an executable ("网易UU远程服务" instead of
# "GameViewerServer.exe"). Windows keeps this in the PE resources, so it costs
# one file open per unique path and is cached for the life of the collector.
$script:versionCache = @{}
function Get-ExeProduct([string] $path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return '' }
    if ($script:versionCache.ContainsKey($path)) { return $script:versionCache[$path] }
    $label = ''
    try {
        $info = (Get-Item -LiteralPath $path -ErrorAction SilentlyContinue).VersionInfo
        if ($info) {
            if (-not [string]::IsNullOrWhiteSpace($info.FileDescription)) { $label = [string]$info.FileDescription }
            elseif (-not [string]::IsNullOrWhiteSpace($info.ProductName)) { $label = [string]$info.ProductName }
        }
    } catch {
        # An unreadable exe simply has no product name.
    }
    if ($label.Length -gt 80) { $label = $label.Substring(0, 80) }
    if ($script:versionCache.Count -lt 400) { $script:versionCache[$path] = $label }
    return $label
}

# Targeted lookup for PIDs that started after the last full table refresh.
function Read-ProcessInfoFor([int[]] $pids) {
    $table = @{}
    if ($pids.Count -eq 0) { return $table }
    $filter = ($pids | ForEach-Object { "ProcessId=$_" }) -join ' OR '
    $rows = Get-CimInstance Win32_Process -Property ProcessId, Name, ExecutablePath, CommandLine -Filter $filter -ErrorAction SilentlyContinue
    foreach ($row in $rows) {
        $cmd = $row.CommandLine
        if ($cmd -ne $null -and $cmd.Length -gt 512) { $cmd = $cmd.Substring(0, 512) }
        $table[[int]$row.ProcessId] = [ordered]@{
            name = [string]$row.Name
            exe  = [string]$row.ExecutablePath
            cmd  = [string]$cmd
        }
    }
    return $table
}

# Total plus per-core CPU. PercentProcessorTime here is already normalised to
# 0-100 per core, so the array can be drawn as a core grid without rescaling.
function Read-OsCpu {
    $total = 0
    $cores = @()
    $queue = 0
    $clock = 0
    $rows = Get-CimInstance -ClassName $osCpuClass -ErrorAction SilentlyContinue
    foreach ($row in $rows) {
        $name = [string]$row.Name
        if ($name -eq '_Total') {
            $total = [int]$row.PercentProcessorTime
            $queue = [int]$row.PercentPrivilegedTime
            continue
        }
        if ($name -match '^\d+$') { $cores += [int]$row.PercentProcessorTime }
    }
    return [ordered]@{ util = $total; cores = $cores; privileged = $queue; clockMHz = $clock }
}

# RAM: total comes from ComputerSystem, free from OperatingSystem.
function Read-Memory {
    $totalMB = 0
    $freeMB = 0
    $os = Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize, FreePhysicalMemory -ErrorAction SilentlyContinue
    if ($os) {
        $totalMB = [long]([double]$os.TotalVisibleMemorySize / 1024)
        $freeMB = [long]([double]$os.FreePhysicalMemory / 1024)
    }
    if ($totalMB -le 0) { $totalMB = [long]([double]$script:memTotalBytes / 1MB) }
    $usedMB = [math]::Max(0, $totalMB - $freeMB)
    $pct = if ($totalMB -gt 0) { [math]::Round(($usedMB / $totalMB) * 100, 1) } else { 0 }
    return [ordered]@{ totalMB = $totalMB; usedMB = $usedMB; availMB = $freeMB; pct = $pct }
}

# Per-process CPU from KernelModeTime+UserModeTime deltas. Values are 100ns
# ticks, so delta/1e7 is CPU-seconds; dividing by the wall clock and the core
# count turns that into "percent of the whole machine" (0-100, all cores).
$cpuPrev = @{}
function Read-ProcessCpu([datetime] $now) {
    $map = @{}
    $total = 0.0
    $rows = Get-CimInstance Win32_Process -Property ProcessId, KernelModeTime, UserModeTime, WorkingSetSize -ErrorAction SilentlyContinue
    foreach ($row in $rows) {
        $procId = [int]$row.ProcessId
        if ($procId -le 0) { continue }
        $ticks = [long]$row.KernelModeTime + [long]$row.UserModeTime
        $ram = [long]$row.WorkingSetSize
        $pct = 0.0
        $previous = $cpuPrev[$procId]
        if ($previous -ne $null -and $previous.ticks -gt 0 -and $ticks -ge $previous.ticks) {
            $seconds = ($now - $previous.at).TotalSeconds
            if ($seconds -gt 0.2) {
                $deltaSeconds = ($ticks - $previous.ticks) / 1e7
                $pct = ($deltaSeconds / $seconds) * 100.0 / $coreCount
            }
        }
        $cpuPrev[$procId] = @{ ticks = $ticks; at = $now }
        $map[$procId] = [ordered]@{ cpu = [math]::Round($pct, 2); ram = $ram }
        $total += $pct
    }
    return [ordered]@{ map = $map; total = [math]::Round([math]::Min(100.0, $total), 1) }
}

$script:memTotalBytes = 0
try {
    $hardware = Get-CimInstance Win32_ComputerSystem -Property TotalPhysicalMemory -ErrorAction SilentlyContinue
    if ($hardware) { $script:memTotalBytes = [long]$hardware.TotalPhysicalMemory }
} catch {
    $script:memTotalBytes = 0
}

$util = @{}
$procTable = @{}
$osCpu = [ordered]@{ util = 0; cores = @(); privileged = 0; clockMHz = 0 }
$memory = [ordered]@{ totalMB = 0; usedMB = 0; availMB = 0; pct = 0 }
$round = 0

while ($true) {
    # Retire with the Host: an orphan would otherwise sample forever.
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
        break
    }
    $started = [DateTime]::UtcNow
    $mem = Read-ProcessVram
    $cpuNow = [DateTime]::UtcNow
    $procCpuSample = Read-ProcessCpu $cpuNow
    $procCpu = $procCpuSample.map
    if (($round % $EngineEvery) -eq 0) { $util = Read-ProcessUtil }
    if (($round % $OsCpuEvery) -eq 0 -or $osCpu.cores.Count -eq 0) { $osCpu = Read-OsCpu }
    if (($round % $MemEvery) -eq 0 -or $memory.totalMB -le 0) { $memory = Read-Memory }
    if (($round % $ProcInfoEvery) -eq 0 -or $procTable.Count -eq 0) {
        $procTable = Read-ProcessInfo
    }
    $round++

    $procs = @()
    $pidSet = New-Object System.Collections.Generic.HashSet[int]
    foreach ($k in $mem.Keys) { [void]$pidSet.Add($k) }
    foreach ($k in $util.Keys) { [void]$pidSet.Add($k) }

    # Anything GPU-active but absent from the cached table started recently.
    $missing = @($pidSet | Where-Object { -not $procTable.ContainsKey($_) })
    if ($missing.Count -gt 0) {
        $fresh = Read-ProcessInfoFor -pids $missing
        foreach ($key in $fresh.Keys) { $procTable[$key] = $fresh[$key] }
    }

    foreach ($procId in $pidSet) {
        $memValue = 0
        if ($mem.ContainsKey($procId)) { $memValue = [long]$mem[$procId] }
        $utilValue = 0.0
        if ($util.ContainsKey($procId)) { $utilValue = [double]$util[$procId] }
        $cpuValue = 0.0
        $ramValue = 0
        if ($procCpu.ContainsKey($procId)) {
            $cpuValue = [double]$procCpu[$procId].cpu
            $ramValue = [long]$procCpu[$procId].ram
        }
        # Shells and render helpers hold trivial VRAM and no compute: skip them.
        if ($memValue -lt 1MB -and $utilValue -lt 1.0) { continue }
        $info = $procTable[$procId]
        $exePath = if ($info) { $info.exe } else { '' }
        $entry = [ordered]@{
            pid  = $procId
            name = if ($info) { $info.name } else { '' }
            exe  = $exePath
            prod = Get-ExeProduct $exePath
            cmd  = if ($info) { $info.cmd } else { '' }
            mem  = $memValue
            util = [math]::Round([math]::Min(100.0, $utilValue), 1)
            cpu  = [math]::Round([math]::Min(100.0, $cpuValue), 2)
            ram  = $ramValue
        }
        # PDH can report a PID for a moment after exit; mark it dead.
        if (-not $info) { $entry.dead = $true }
        $procs += $entry
    }

    # CPU/RAM heavy processes that never touch the GPU still belong on a
    # resource dashboard (Blender, UnrealEditor, a runaway node worker).
    $seen = New-Object System.Collections.Generic.HashSet[int]
    foreach ($entry in $procs) { [void]$seen.Add([int]$entry.pid) }
    $extra = @()
    foreach ($procId in $procCpu.Keys) {
        if ($seen.Contains($procId)) { continue }
        $cpuValue = [double]$procCpu[$procId].cpu
        $ramValue = [long]$procCpu[$procId].ram
        if ($cpuValue -lt 0.35 -and $ramValue -lt 600MB) { continue }
        $info = $procTable[$procId]
        if (-not $info) { continue }
        $extra += [ordered]@{
            pid  = $procId
            name = $info.name
            exe  = $info.exe
            prod = Get-ExeProduct $info.exe
            cmd  = $info.cmd
            mem  = 0
            util = 0
            cpu  = [math]::Round([math]::Min(100.0, $cpuValue), 2)
            ram  = $ramValue
        }
    }
    if ($extra.Count -gt 0) {
        # Keep the payload bounded: the heaviest 40 non-GPU processes by CPU.
        $extra = @($extra | Sort-Object -Property { $_.cpu } -Descending | Select-Object -First 40)
        $procs += $extra
    }

    # The per-process deltas give a machine-wide total every round; the PerfOS
    # class is authoritative but only refreshes every other round.
    $osCpu.procUtil = $procCpuSample.total

    $payload = [ordered]@{
        t          = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        elapsedMs  = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
        cores      = $coreCount
        gpus       = @(Read-Smi)
        cpu        = $osCpu
        mem        = $memory
        procs      = $procs
    }
    $line = ($payload | ConvertTo-Json -Compress -Depth 6) + "`n"
    $bytes = $utf8.GetBytes($line)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
    Start-Sleep -Milliseconds $IntervalMs
}

# Only the owner of the pid file clears it, so a newer collector's lock survives.
try {
    if ((Test-Path $pidFile) -and ((Get-Content $pidFile -TotalCount 1).Trim() -eq [string]$PID)) {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
} catch {
    # Best effort.
}

