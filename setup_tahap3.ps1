# =============================================================
# TELCO AIOPS — Tahap 3 Setup Script (PowerShell)
# Jalankan: .\setup_tahap3.ps1
# =============================================================

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║     TELCO AIOPS — Tahap 3: MLOps                    ║" -ForegroundColor Cyan
Write-Host "║     Train Model + Deploy REST API                    ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ─── STEP 1: Install packages ─────────────────────────────
Write-Host "━━━ Step 1: Install Python packages ━━━" -ForegroundColor Blue
pip install -q `
    scikit-learn==1.3.0 `
    mlflow==2.8.0 `
    fastapi==0.104.0 `
    uvicorn==0.24.0 `
    prometheus-client==0.18.0 `
    joblib==1.3.0 `
    pydantic==2.5.0

Write-Host "✅ Packages terinstall" -ForegroundColor Green

# ─── STEP 2: Deploy MLflow server ─────────────────────────
Write-Host ""
Write-Host "━━━ Step 2: Deploy MLflow Tracking Server ━━━" -ForegroundColor Blue

Set-Location mlflow
docker-compose up -d
Set-Location ..

Write-Host "⏳ Menunggu MLflow siap (30 detik)..." -ForegroundColor Yellow
Start-Sleep -Seconds 30

try {
    $r = Invoke-WebRequest -Uri "http://localhost:5000" -TimeoutSec 10
    Write-Host "✅ MLflow UI tersedia di http://localhost:5000" -ForegroundColor Green
} catch {
    Write-Host "⚠️  MLflow masih booting, lanjutkan training..." -ForegroundColor Yellow
}

# ─── STEP 3: Training ─────────────────────────────────────
Write-Host ""
Write-Host "━━━ Step 3: Training Model ━━━" -ForegroundColor Blue
Write-Host "ℹ️  Ini akan mengambil data dari MinIO dan melatih 2 model" -ForegroundColor Cyan

python model/train.py

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Training selesai!" -ForegroundColor Green
} else {
    Write-Host "❌ Training gagal. Cek output di atas." -ForegroundColor Red
    exit 1
}

# ─── SUMMARY ──────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  ✅  TAHAP 3 SIAP!                                  ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "Langkah selanjutnya:" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. Lihat hasil training di MLflow:" -ForegroundColor White
Write-Host "     http://localhost:5000" -ForegroundColor Yellow
Write-Host ""
Write-Host "  2. Jalankan Model API server (terminal baru):" -ForegroundColor White
Write-Host "     python api/model_server.py" -ForegroundColor Yellow
Write-Host ""
Write-Host "  3. Test prediksi di Swagger UI:" -ForegroundColor White
Write-Host "     http://localhost:8080/docs" -ForegroundColor Yellow
Write-Host ""
Write-Host "  4. Lihat Prometheus metrics:" -ForegroundColor White
Write-Host "     http://localhost:8080/metrics" -ForegroundColor Yellow
Write-Host ""
