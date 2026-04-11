# ================================================================
# TELCO AIOPS -- stop.ps1
# Stop semua proses Python dan containers.
# Jalankan: PowerShell -ExecutionPolicy Bypass -File .\stop.ps1
# ================================================================

$ErrorActionPreference = "SilentlyContinue"
$ROOT = $PSScriptRoot

Write-Host ""
Write-Host "=================================================" -ForegroundColor Red
Write-Host "   TELCO AIOPS -- Stopping all services         " -ForegroundColor Red
Write-Host "=================================================" -ForegroundColor Red
Write-Host ""

# ── Stop Python processes ─────────────────────────────────────
Write-Host "--- Stop proses Python ---" -ForegroundColor Blue
$pidFile = "$ROOT\.aiops_pids.json"
if (Test-Path $pidFile) {
    $pids = Get-Content $pidFile | ConvertFrom-Json
    $pids.PSObject.Properties | ForEach-Object {
        try {
            Stop-Process -Id $_.Value -Force -ErrorAction Stop
            Write-Host "  [OK] $($_.Name) (PID $($_.Value)) stopped" -ForegroundColor Green
        } catch {
            Write-Host "  [--] $($_.Name) sudah tidak berjalan" -ForegroundColor DarkGray
        }
    }
    Remove-Item $pidFile -Force
} else {
    # Fallback: kill semua python yang terkait
    $scripts = @("log_generator","kafka_to_minio","model_server","auto_predictor")
    Get-WmiObject Win32_Process -Filter "Name='python.exe'" | ForEach-Object {
        $cmd = $_.CommandLine
        foreach ($s in $scripts) {
            if ($cmd -like "*$s*") {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
                Write-Host "  [OK] $s (PID $($_.ProcessId)) stopped" -ForegroundColor Green
            }
        }
    }
}

# ── Stop Docker containers ────────────────────────────────────
Write-Host ""
Write-Host "--- Stop Docker containers ---" -ForegroundColor Blue
$containers = @("telco-zookeeper","telco-kafka","telco-minio","telco-prometheus","telco-grafana","telco-mlflow")
foreach ($c in $containers) {
    docker stop $c 2>$null | Out-Null
    Write-Host "  [OK] $c stopped" -ForegroundColor Green
}

Write-Host ""
Write-Host "  Semua service dihentikan." -ForegroundColor Green
Write-Host "  Jalankan start.ps1 untuk memulai ulang." -ForegroundColor DarkGray
Write-Host ""
