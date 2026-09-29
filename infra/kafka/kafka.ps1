<#
.SYNOPSIS
    Local Kafka broker lifecycle for machines without Docker (Day 7).

.DESCRIPTION
    The Docker path (docker-compose.kafka.yml) is the preferred one when Docker
    is available. This script is the fallback used on machines where it is not:
    it runs a normal Apache Kafka distribution in KRaft mode (no ZooKeeper)
    using a portable JRE.

    It only ever touches files under $KafkaDataDir (plus one generated config
    file inside the Kafka installation), so it is safe to re-run.

    Prerequisites (one-time, outside this script - see docs/KAFKA.md §2):
      1. a JRE/JDK 11+ (developed against Temurin 21)
      2. an Apache Kafka distribution (developed against 3.9.0)

.PARAMETER Action
    setup   format the storage directory (one time, idempotent) and write the config
    start   setup if needed, then start the broker in the background and wait for the port
    stop    stop the broker listening on the port
    status  report whether the broker port is accepting connections
    topics  list topics (requires a running broker)
    consume read messages from a topic (requires a running broker)
    reset   stop, delete all broker data, and re-format (destroys events)

.EXAMPLE
    .\infra\kafka\kafka.ps1 -Action start
    .\infra\kafka\kafka.ps1 -Action topics
    .\infra\kafka\kafka.ps1 -Action consume -Topic notification-service.dlq
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('setup', 'start', 'stop', 'status', 'topics', 'consume', 'reset')]
    [string]$Action,

    [string]$Topic = 'order.events',
    [int]$Port = 9092,
    [string]$KafkaHome = $(if ($env:KAFKA_HOME) { $env:KAFKA_HOME } else { Join-Path $env:USERPROFILE 'kafka-local\kafka_2.13-3.9.0' }),
    [string]$JavaHome = $(if ($env:JAVA_HOME) { $env:JAVA_HOME } else { (Get-ChildItem (Join-Path $env:USERPROFILE 'kafka-local\jre') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName) }),
    [string]$KafkaDataDir = $(if ($env:KAFKA_DATA_DIR) { $env:KAFKA_DATA_DIR } else { Join-Path $env:USERPROFILE 'kafka-local\data' })
)

$ErrorActionPreference = 'Stop'

$ControllerPort = $Port + 1
$TemplatePath = Join-Path $PSScriptRoot 'kraft-server.properties'
$ConfigPath = Join-Path $KafkaHome 'config\kraft\ecommerce-server.properties'
$LogDir = Join-Path (Split-Path $KafkaDataDir -Parent) 'logs'
$StdOut = Join-Path $LogDir 'kafka.out.log'
$StdErr = Join-Path $LogDir 'kafka.err.log'
$FormattedMarker = Join-Path $KafkaDataDir 'meta.properties'

# ---------------------------------------------------------------------------
# WHY WE CALL java DIRECTLY INSTEAD OF THE BUNDLED kafka-*.bat WRAPPERS
# ---------------------------------------------------------------------------
# The Windows wrappers build the classpath by listing all ~120 jars in `libs\`
# one by one, which blows past cmd.exe's 8191-character command-line limit and
# fails with "The input line is too long." on a normal Windows shell.
#
# Java itself supports a wildcard classpath entry, so we skip the wrapper and
# invoke the same main classes directly:
#
#   kafka.tools.StorageTool     (what bin/windows/kafka-storage.bat runs)
#   kafka.Kafka                 (what bin/windows/kafka-server-start.bat runs)
#   org.apache.kafka.tools.TopicCommand                   (kafka-topics.bat)
#   org.apache.kafka.tools.consumer.ConsoleConsumer       (kafka-console-consumer.bat)
#
# This is purely a dev-environment workaround; it changes no broker behaviour.
# ---------------------------------------------------------------------------
$JavaExe = Join-Path $JavaHome 'bin\java.exe'
$LibsClasspath = Join-Path $KafkaHome 'libs\*'
$ToolsLog4j = 'file:' + ((Join-Path $KafkaHome 'config\tools-log4j.properties') -replace '\\', '/')
$ServerLog4j = 'file:' + ((Join-Path $KafkaHome 'config\log4j.properties') -replace '\\', '/')
# The stock log4j.properties writes its file appenders under ${kafka.logs.dir}.
# The .sh wrappers set this property; the .bat wrappers expect it to already be
# set, so we pass it explicitly (otherwise the broker logs a FileAppender error
# for [stateChangeAppender] at startup). It is a PLAIN directory path - not a
# file: URL - because log4j substitutes it straight into a filename.
$ServerLogsDir = $LogDir

# Runs one Kafka tool class. Returns @{ ExitCode; Output } and never throws,
# so the caller can decide how to report a failure.
function Invoke-KafkaClass {
    param(
        [Parameter(Mandatory = $true)][string]$MainClass,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$Log4jConfig = $ToolsLog4j
    )
    # 2>&1 merges stderr so log4j warnings and JVM errors are visible too.
    $output = & $JavaExe '-Xmx256M' "-Dlog4j.configuration=$Log4jConfig" -cp $LibsClasspath $MainClass @Arguments 2>&1
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = @($output) }
}

function Write-ToolOutput($lines) {
    foreach ($line in $lines) { Write-Host $line }
}



function Assert-Prerequisites {
    if (-not (Test-Path $KafkaHome)) {
        throw "Kafka not found at '$KafkaHome'. Set KAFKA_HOME or pass -KafkaHome. See docs/KAFKA.md section 2."
    }
    if (-not (Test-Path (Join-Path $KafkaHome 'libs'))) {
        throw "'$KafkaHome' does not look like a full Kafka distribution (no libs directory)."
    }
    if (-not $JavaHome -or -not (Test-Path $JavaExe)) {
        throw "No JRE/JDK found at '$JavaHome'. Set JAVA_HOME or pass -JavaHome. See docs/KAFKA.md section 2."
    }
}

function Write-Config {
    if (-not (Test-Path $TemplatePath)) { throw "Template missing: $TemplatePath" }
    New-Item -ItemType Directory -Force -Path (Split-Path $ConfigPath) | Out-Null
    New-Item -ItemType Directory -Force -Path $KafkaDataDir, $LogDir | Out-Null

    (Get-Content $TemplatePath -Raw) `
        -replace '__PORT__', $Port `
        -replace '__CONTROLLER_PORT__', $ControllerPort `
        -replace '__LOG_DIRS__', ($KafkaDataDir -replace '\\', '/') |
        Set-Content -Path $ConfigPath -Encoding ascii

    Write-Host "[kafka-local] config written: $ConfigPath"
}

function Invoke-StorageFormat {
    if (Test-Path $FormattedMarker) {
        Write-Host '[kafka-local] storage already formatted (skipping)'
        return
    }
    Write-Host '[kafka-local] formatting storage...'

    $uuid = Invoke-KafkaClass -MainClass 'kafka.tools.StorageTool' -Arguments @('random-uuid')
    $clusterId = ($uuid.Output | Where-Object { $_ -match '^[A-Za-z0-9_-]{20,}$' } | Select-Object -Last 1)
    if (-not $clusterId) {
        Write-ToolOutput $uuid.Output
        throw 'Could not obtain a cluster id from kafka-storage random-uuid'
    }

    $format = Invoke-KafkaClass -MainClass 'kafka.tools.StorageTool' `
        -Arguments @('format', '-t', $clusterId.Trim(), '-c', $ConfigPath)
    Write-ToolOutput $format.Output
    if ($format.ExitCode -ne 0) { throw "kafka-storage format failed with exit code $($format.ExitCode)" }
}



function Test-BrokerUp {
    return (Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue)
}

function Wait-ForBroker([int]$TimeoutSeconds = 90) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-BrokerUp) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

switch ($Action) {
    'setup' {
        Assert-Prerequisites
        Write-Config
        Invoke-StorageFormat
        Write-Host '[kafka-local] setup complete'
    }
    'start' {
        Assert-Prerequisites
        if (Test-BrokerUp) {
            Write-Host "[kafka-local] already listening on 127.0.0.1:$Port"
            break
        }
        Write-Config
        Invoke-StorageFormat

        Write-Host "[kafka-local] starting broker on 127.0.0.1:$Port (logs: $StdOut)"
        $heap = if ($env:KAFKA_HEAP_OPTS) { $env:KAFKA_HEAP_OPTS } else { '-Xmx1G -Xms1G' }
        Start-Process -FilePath $JavaExe `
            -ArgumentList (@($heap.Split(' ')) + @("-Dlog4j.configuration=$ServerLog4j", "-Dkafka.logs.dir=$ServerLogsDir", '-cp', $LibsClasspath, 'kafka.Kafka', $ConfigPath)) `
            -WindowStyle Hidden -RedirectStandardOutput $StdOut -RedirectStandardError $StdErr

        if (Wait-ForBroker) {
            Write-Host "[kafka-local] broker ready (controller port $ControllerPort)"
        } else {
            Write-Host "[kafka-local] broker did NOT come up. Last lines of the logs:"
            Get-Content $StdOut -Tail 20 -ErrorAction SilentlyContinue
            Get-Content $StdErr -Tail 20 -ErrorAction SilentlyContinue
            exit 1
        }
    }
    'stop' {
        Assert-Prerequisites
        $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if (-not $connections) {
            Write-Host '[kafka-local] no broker listening'
            break
        }
        foreach ($owner in ($connections | Select-Object -ExpandProperty OwningProcess -Unique)) {
            Write-Host "[kafka-local] stopping PID $owner"
            Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
        }
        # Give Kafka a moment to release the data directory and controller port.
        Start-Sleep -Seconds 3
        Write-Host '[kafka-local] stopped'
    }
    'status' {
        Assert-Prerequisites
        if (Test-BrokerUp) {
            Write-Host "[kafka-local] UP - 127.0.0.1:$Port"
        } else {
            Write-Host "[kafka-local] DOWN - nothing listening on 127.0.0.1:$Port"
            exit 1
        }
    }
    'topics' {
        Assert-Prerequisites
        $result = Invoke-KafkaClass -MainClass 'org.apache.kafka.tools.TopicCommand' `
            -Arguments @('--bootstrap-server', "127.0.0.1:$Port", '--list')
        Write-ToolOutput $result.Output
    }
    'consume' {
        Assert-Prerequisites
        Write-Host "[kafka-local] reading $Topic from the beginning (Ctrl+C to stop)..."
        $result = Invoke-KafkaClass -MainClass 'org.apache.kafka.tools.consumer.ConsoleConsumer' `
            -Arguments @('--bootstrap-server', "127.0.0.1:$Port", '--topic', $Topic, '--from-beginning',
                '--property', 'print.key=true', '--property', 'print.headers=true')
        Write-ToolOutput $result.Output
    }
    'reset' {
        Assert-Prerequisites
        & $PSCommandPath -Action stop -Port $Port -KafkaHome $KafkaHome -JavaHome $JavaHome -KafkaDataDir $KafkaDataDir
        if (Test-Path $KafkaDataDir) {
            Remove-Item -Recurse -Force $KafkaDataDir
            Write-Host "[kafka-local] deleted $KafkaDataDir"
        }
        Write-Config
        Invoke-StorageFormat
        Write-Host '[kafka-local] reset complete - start with: .\infra\kafka\kafka.ps1 -Action start'
    }
}


