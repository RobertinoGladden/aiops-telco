$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    docker compose --profile training run --rm trainer
    if ($LASTEXITCODE -ne 0) { throw "Training gagal. Cek data/features, label, dan MLflow." }
    docker compose restart model-api
    if ($LASTEXITCODE -ne 0) { throw "Model tersimpan, tetapi restart API gagal." }
    Write-Host "Training selesai. API memuat MODEL_NAME dari .env; cek /health." -ForegroundColor Green
} finally {
    Pop-Location
}
