# =============================================================
# TELCO AIOPS — Tahap 2 Setup Script (PowerShell)
# Jalankan: .\setup_tahap2.ps1
# =============================================================

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║     TELCO AIOPS — Tahap 2: Data Engineering         ║" -ForegroundColor Cyan
Write-Host "║     Kafka Consumer + Airflow Pipeline                ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ─── STEP 1: Install Python packages ──────────────────────
Write-Host "━━━ Step 1: Install Python packages ━━━" -ForegroundColor Blue
pip install -q `
    kafka-python==2.0.2 `
    pandas==2.1.0 `
    pyarrow==14.0.0 `
    boto3==1.29.0 `
    fastparquet==2023.10.1

Write-Host "✅ Packages terinstall" -ForegroundColor Green

# ─── STEP 2: Test koneksi MinIO ───────────────────────────
Write-Host ""
Write-Host "━━━ Step 2: Test koneksi MinIO ━━━" -ForegroundColor Blue

$testScript = @"
import boto3
from botocore.client import Config
try:
    client = boto3.client('s3',
        endpoint_url='http://127.0.0.1:9000',
        aws_access_key_id='telcoadmin',
        aws_secret_access_key='telcopassword123',
        config=Config(signature_version='s3v4'),
        region_name='us-east-1'
    )
    buckets = [b['Name'] for b in client.list_buckets()['Buckets']]
    print('OK:', buckets)
except Exception as e:
    print('ERROR:', e)
"@

$result = python -c $testScript
Write-Host "MinIO: $result" -ForegroundColor Green

# ─── STEP 3: Jalankan Airflow via Docker ──────────────────
Write-Host ""
Write-Host "━━━ Step 3: Deploy Airflow ━━━" -ForegroundColor Blue
Write-Host "ℹ️  Airflow akan jalan di http://localhost:8080" -ForegroundColor Cyan
Write-Host "   Login: admin / telco123" -ForegroundColor Cyan

Set-Location airflow
docker-compose up -d --build

Write-Host ""
Write-Host "⏳ Menunggu Airflow siap (60 detik)..." -ForegroundColor Yellow
Start-Sleep -Seconds 60

# Cek apakah Airflow webserver merespons
try {
    $response = Invoke-WebRequest -Uri "http://localhost:8080/health" -TimeoutSec 10
    Write-Host "✅ Airflow webserver UP" -ForegroundColor Green
} catch {
    Write-Host "⚠️  Airflow mungkin masih booting, cek manual di http://localhost:8080" -ForegroundColor Yellow
}

Set-Location ..

# ─── SUMMARY ──────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  ✅  TAHAP 2 SIAP!                                  ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "Langkah selanjutnya:" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. Jalankan Kafka Consumer (terminal baru):" -ForegroundColor White
Write-Host "     python consumer/kafka_to_minio.py" -ForegroundColor Yellow
Write-Host ""
Write-Host "  2. Buka Airflow UI:" -ForegroundColor White
Write-Host "     http://localhost:8080  (admin / telco123)" -ForegroundColor Yellow
Write-Host ""
Write-Host "  3. Aktifkan DAG 'telco_data_pipeline' di Airflow UI" -ForegroundColor White
Write-Host ""
Write-Host "  4. Cek data masuk di MinIO:" -ForegroundColor White
Write-Host "     http://localhost:9001 → telco-raw-data" -ForegroundColor Yellow
Write-Host ""
