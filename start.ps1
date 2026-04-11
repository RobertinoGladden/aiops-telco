# ================================================================
# TELCO AIOPS -- start.ps1 (FIXED)
# Perubahan dari versi lama:
#   1. Kill proses lama di port 8081 sebelum start model_server
#   2. Start auto_predictor SETELAH model API confirmed ready
#   3. Timeout tunggu API diperpanjang ke 90 detik
# ================================================================

$ErrorActionPreference = "SilentlyContinue"
$ROOT = $PSScriptRoot

function Log-OK($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Log-Warn($m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Log-Info($m) { Write-Host "  [i]  $m" -ForegroundColor Cyan }
function Log-Step($m) { Write-Host "" ; Write-Host "--- $m ---" -ForegroundColor Blue }
function Log-Err($m)  { Write-Host "  [X] $m" -ForegroundColor Red }

Clear-Host
Write-Host ""
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "   TELCO AIOPS -- One-Command Startup           " -ForegroundColor Cyan
Write-Host "   Network Anomaly Predictor and Auto-Healer    " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Docker ────────────────────────────────────────────────
Log-Step "1. Cek Docker"
docker info 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Log-Err "Docker tidak berjalan! Buka Docker Desktop dulu lalu jalankan ulang."
    Read-Host "Tekan Enter untuk keluar"
    exit 1
}
Log-OK "Docker aktif"

# ── 2. Start containers ──────────────────────────────────────
Log-Step "2. Start Docker containers"
$containers = @("telco-zookeeper","telco-kafka","telco-minio","telco-prometheus","telco-grafana","telco-mlflow")
$missing = @()
foreach ($c in $containers) {
    $s = docker inspect --format "{{.State.Status}}" $c 2>$null
    if ($s -eq "running") {
        Log-OK "$c sudah running"
    } elseif ($s -eq "exited" -or $s -eq "created") {
        docker start $c | Out-Null
        Log-OK "$c started"
    } else {
        $missing += $c
        Log-Warn "$c tidak ditemukan"
    }
}
if ($missing.Count -gt 0) {
    Log-Warn "Ada container yang hilang. Jalankan ini dulu:"
    Write-Host "    cd $ROOT\terraform && terraform apply -auto-approve" -ForegroundColor Yellow
    Read-Host "Tekan Enter untuk keluar"
    exit 1
}

# ── 3. Tunggu Kafka ──────────────────────────────────────────
Log-Step "3. Tunggu Kafka siap"
$kafkaReady = $false
for ($i = 1; $i -le 12; $i++) {
    Start-Sleep -Seconds 3
    docker exec telco-kafka kafka-topics --bootstrap-server localhost:9092 --list 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $kafkaReady = $true; Log-OK "Kafka siap ($($i*3)s)"; break }
    Write-Host "  ... $($i*3)s" -ForegroundColor DarkGray
}
if (-not $kafkaReady) { Log-Warn "Kafka belum merespons, lanjut..." }

# ── 4. Pastikan MinIO bucket ada ─────────────────────────────
Log-Step "4. Setup MinIO buckets"
$bucketScript = @"
import boto3, sys
from botocore.client import Config
try:
    c = boto3.client('s3', endpoint_url='http://127.0.0.1:9000',
        aws_access_key_id='telcoadmin', aws_secret_access_key='telcopassword123',
        config=Config(signature_version='s3v4'), region_name='us-east-1')
    for b in ['telco-raw-data','telco-processed-data','telco-models']:
        try: c.create_bucket(Bucket=b); print(f'[OK] bucket: {b}')
        except: print(f'[--] sudah ada: {b}')
except Exception as e:
    print(f'[X] MinIO error: {e}'); sys.exit(1)
"@
$bucketResult = & "$ROOT\venv\Scripts\python.exe" -c $bucketScript 2>&1
$bucketResult | ForEach-Object {
    Write-Host "  $_" -ForegroundColor $(if ($_ -match "\[OK\]") {"Green"} elseif ($_ -match "\[X\]") {"Red"} else {"DarkGray"})
}

# ── 5. Cek apakah model sudah ada di MinIO ───────────────────
Log-Step "5. Cek model AI"
$modelCheck = @"
import boto3, sys
from botocore.client import Config
c = boto3.client('s3', endpoint_url='http://127.0.0.1:9000',
    aws_access_key_id='telcoadmin', aws_secret_access_key='telcopassword123',
    config=Config(signature_version='s3v4'), region_name='us-east-1')
try:
    c.head_object(Bucket='telco-models', Key='latest/random_forest.pkl')
    print('EXISTS')
except: print('MISSING')
"@
$modelStatus = & "$ROOT\venv\Scripts\python.exe" -c $modelCheck 2>&1

if ($modelStatus -match "MISSING") {
    Log-Warn "Model belum ada. Training dulu (butuh data di MinIO)..."
    $choice = Read-Host "  Mau training model sekarang? (y/N)"
    if ($choice -eq "y" -or $choice -eq "Y") {
        & "$ROOT\venv\Scripts\python.exe" "$ROOT\model\train.py"
        if ($LASTEXITCODE -ne 0) { Log-Err "Training gagal."; exit 1 }
        Log-OK "Training selesai"
    } else {
        Log-Warn "Sistem akan jalan tanpa auto predictor (model belum ada)"
    }
} else {
    Log-OK "Model tersedia di MinIO"
}

# ── 6. Kill proses python lama & bersihkan port 8081 ─────────
# PERUBAHAN: kill port 8081 dulu sebelum start model_server baru
Log-Step "6. Menjalankan semua proses"

$python = "$ROOT\venv\Scripts\python.exe"

# Kill semua proses python lama
Get-Process -Name "python" -ErrorAction SilentlyContinue | ForEach-Object {
    $cmdline = (Get-WmiObject Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
    if ($cmdline -like "*aiops*" -or $cmdline -like "*log_generator*" -or
        $cmdline -like "*kafka_to_minio*" -or $cmdline -like "*model_server*" -or
        $cmdline -like "*auto_predictor*") {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
}

# PERUBAHAN: Kill proses yang masih pakai port 8081 (sisa dari run sebelumnya)
$port8081 = netstat -ano | findstr ":8081" | findstr "LISTENING"
if ($port8081) {
    $pidOld = ($port8081 -split '\s+')[-1]
    if ($pidOld -and $pidOld -ne "0") {
        Stop-Process -Id $pidOld -Force -ErrorAction SilentlyContinue
        Log-Info "Killed proses lama di port 8081 (PID $pidOld)"
        Start-Sleep -Seconds 2
    }
}

# Log dir
$logDir = "$ROOT\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Start 3 proses awal (log_generator, kafka_to_minio, model_server)
# PERUBAHAN: auto_predictor belum distart di sini - tunggu model API ready dulu
$earlyJobs = @(
    @{ name="log_generator";  script="scripts/log_generator.py";   log="log_generator.log"  },
    @{ name="kafka_to_minio"; script="consumer/kafka_to_minio.py"; log="kafka_to_minio.log" },
    @{ name="model_server";   script="api/model_server.py";        log="model_server.log"   }
)

$pids = @{}
foreach ($job in $earlyJobs) {
    $logFile = "$logDir\$($job.log)"
    $proc = Start-Process -FilePath $python `
        -ArgumentList "$ROOT\$($job.script)" `
        -WorkingDirectory $ROOT `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError "$logFile.err" `
        -WindowStyle Hidden `
        -PassThru
    $pids[$job.name] = $proc.Id
    Log-OK "$($job.name) started (PID $($proc.Id)) -- log: logs\$($job.log)"
}

# ── 7. Tunggu model_server ready, BARU start auto_predictor ──
# PERUBAHAN: diperpanjang ke 90 detik, auto_predictor distart di sini setelah ready
Log-Step "7. Tunggu Model API siap"
$apiReady = $false
for ($i = 1; $i -le 45; $i++) {
    Start-Sleep -Seconds 2
    try {
        $h = Invoke-RestMethod -Uri "http://localhost:8081/health" -ErrorAction Stop
        if ($h.loaded) {
            $apiReady = $true
            Log-OK "Model API siap! Model: $($h.model)"
            break
        }
    } catch {}
    Write-Host "  ... $($i*2)s" -ForegroundColor DarkGray
}

if (-not $apiReady) {
    Log-Warn "Model API belum merespons setelah 90s."
    Log-Warn "auto_predictor TIDAK dijalankan. Cek logs\model_server.log.err"
} else {
    # PERUBAHAN: auto_predictor distart SETELAH model API confirmed ready
    $apJob   = @{ name="auto_predictor"; script="predictor/auto_predictor.py"; log="auto_predictor.log" }
    $logFile = "$logDir\$($apJob.log)"
    $proc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c `"`"$python`" `"$ROOT\$($apJob.script)`" >> `"$logFile`" 2>> `"$logFile.err`"`"" `
        -WorkingDirectory $ROOT `
        -WindowStyle Hidden `
        -PassThru
    $pids[$apJob.name] = $proc.Id
    Log-OK "auto_predictor started (PID $($proc.Id)) -- log: logs\$($apJob.log)"
}

# Simpan PIDs untuk stop.ps1
$pids | ConvertTo-Json | Out-File -FilePath "$ROOT\.aiops_pids.json" -Encoding utf8

# ── SUMMARY ──────────────────────────────────────────────────
$jobs = @(
    @{ name="log_generator";  log="log_generator.log"  },
    @{ name="kafka_to_minio"; log="kafka_to_minio.log" },
    @{ name="model_server";   log="model_server.log"   },
    @{ name="auto_predictor"; log="auto_predictor.log" }
)

Write-Host ""
Write-Host "=================================================" -ForegroundColor Green
Write-Host "  Sistem berjalan! Semua proses aktif.          " -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Proses aktif:" -ForegroundColor Cyan
foreach ($job in $jobs) {
    $pid_ = $pids[$job.name]
    $color = if ($pid_) {"DarkGray"} else {"Yellow"}
    Write-Host "  $($job.name.PadRight(18)) PID $("$pid_".PadRight(8))  -->  logs\$($job.log)" -ForegroundColor $color
}
Write-Host ""
Write-Host "  Dashboard:" -ForegroundColor Cyan
Write-Host "  Grafana    --> http://localhost:3000  (admin / telco123)" -ForegroundColor Blue
Write-Host "  MinIO      --> http://localhost:9001  (telcoadmin / telcopassword123)" -ForegroundColor Blue
Write-Host "  Prometheus --> http://localhost:9090" -ForegroundColor Blue
Write-Host "  MLflow     --> http://localhost:5000" -ForegroundColor Blue
Write-Host "  Model API  --> http://localhost:8081/docs" -ForegroundColor Blue
Write-Host ""
Write-Host "  Monitor log real-time:" -ForegroundColor Cyan
Write-Host "  Get-Content logs\auto_predictor.log.err -Wait" -ForegroundColor DarkGray
Write-Host "  Get-Content logs\model_server.log -Wait" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Stop semua: PowerShell -ExecutionPolicy Bypass -File .\stop.ps1" -ForegroundColor Yellow
Write-Host ""