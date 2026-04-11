# ================================================================
# TELCO AIOPS -- status.ps1
# Cek status semua proses dan services.
# Jalankan: PowerShell -ExecutionPolicy Bypass -File .\status.ps1
# ================================================================

$ErrorActionPreference = "SilentlyContinue"
$ROOT = $PSScriptRoot

Write-Host ""
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "   TELCO AIOPS -- System Status                 " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host ""

# ── Docker containers ─────────────────────────────────────────
Write-Host "--- Docker Containers ---" -ForegroundColor Blue
$containers = @("telco-zookeeper","telco-kafka","telco-minio","telco-prometheus","telco-grafana","telco-mlflow")
foreach ($c in $containers) {
    $s = docker inspect --format "{{.State.Status}}" $c 2>$null
    if ($s -eq "running") {
        Write-Host "  [OK] $($c.PadRight(20)) running" -ForegroundColor Green
    } else {
        Write-Host "  [X]  $($c.PadRight(20)) $s" -ForegroundColor Red
    }
}

# ── Python processes ──────────────────────────────────────────
Write-Host ""
Write-Host "--- Python Processes ---" -ForegroundColor Blue
$scripts = @("log_generator","kafka_to_minio","model_server","auto_predictor")
$pidFile = "$ROOT\.aiops_pids.json"
if (Test-Path $pidFile) {
    $savedPids = Get-Content $pidFile | ConvertFrom-Json
    foreach ($s in $scripts) {
        $pid = $savedPids.$s
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "  [OK] $($s.PadRight(20)) running (PID $pid)" -ForegroundColor Green
        } else {
            Write-Host "  [X]  $($s.PadRight(20)) not running" -ForegroundColor Red
        }
    }
} else {
    Write-Host "  [!!] Tidak ada .aiops_pids.json -- jalankan start.ps1 dulu" -ForegroundColor Yellow
}

# ── Model API health ──────────────────────────────────────────
Write-Host ""
Write-Host "--- Model API Health ---" -ForegroundColor Blue
try {
    $h = Invoke-RestMethod -Uri "http://localhost:8081/health" -TimeoutSec 3
    Write-Host "  [OK] Status  : $($h.status)" -ForegroundColor Green
    Write-Host "  [OK] Model   : $($h.model)" -ForegroundColor Green
    Write-Host "  [OK] Loaded  : $($h.loaded)" -ForegroundColor Green
} catch {
    Write-Host "  [X]  Model API tidak merespons di port 8081" -ForegroundColor Red
}

# ── MinIO buckets ─────────────────────────────────────────────
Write-Host ""
Write-Host "--- MinIO Buckets ---" -ForegroundColor Blue
$bucketScript = @"
import boto3
from botocore.client import Config
c = boto3.client('s3', endpoint_url='http://127.0.0.1:9000',
    aws_access_key_id='telcoadmin', aws_secret_access_key='telcopassword123',
    config=Config(signature_version='s3v4'), region_name='us-east-1')
for b in ['telco-raw-data','telco-processed-data','telco-models']:
    try:
        r = c.list_objects_v2(Bucket=b)
        print(f'  [OK] {b:<25} {r[\"KeyCount\"]} files')
    except Exception as e:
        print(f'  [X]  {b:<25} {e}')
"@
& "$ROOT\venv\Scripts\python.exe" -c $bucketScript 2>&1 | ForEach-Object {
    $color = if ($_ -match "\[OK\]") {"Green"} elseif ($_ -match "\[X\]") {"Red"} else {"White"}
    Write-Host $_ -ForegroundColor $color
}

# ── Log terbaru ───────────────────────────────────────────────
Write-Host ""
Write-Host "--- Log Terbaru (auto_predictor) ---" -ForegroundColor Blue
$logFile = "$ROOT\logs\auto_predictor.log"
if (Test-Path $logFile) {
    Get-Content $logFile -Tail 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
} else {
    Write-Host "  Belum ada log" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  Dashboard:" -ForegroundColor Cyan
Write-Host "  Grafana    --> http://localhost:3000" -ForegroundColor Blue
Write-Host "  Prometheus --> http://localhost:9090" -ForegroundColor Blue
Write-Host "  MLflow     --> http://localhost:5000" -ForegroundColor Blue
Write-Host "  Model API  --> http://localhost:8081/docs" -ForegroundColor Blue
Write-Host ""
