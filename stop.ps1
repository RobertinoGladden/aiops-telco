$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    docker compose --profile demo --profile orchestration --profile training stop
    if ($LASTEXITCODE -ne 0) { throw "Sebagian service gagal dihentikan." }
    Write-Host "Service proyek dihentikan; data pada volume tersimpan." -ForegroundColor Green
} finally {
    Pop-Location
}
