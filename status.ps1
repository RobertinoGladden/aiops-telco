$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    docker compose --profile demo --profile orchestration ps -a
    if ($LASTEXITCODE -ne 0) { throw "Gagal membaca status Compose." }
    foreach ($serviceHealth in @(
        @{Name="Model API"; Url="http://127.0.0.1:8081/health"},
        @{Name="Integration Hub"; Url="http://127.0.0.1:8082/health"}
    )) {
        try {
            $result = Invoke-RestMethod -Uri $serviceHealth.Url -TimeoutSec 3
            Write-Host "$($serviceHealth.Name): $($result | ConvertTo-Json -Compress)"
        } catch {
            Write-Host "$($serviceHealth.Name): tidak merespons" -ForegroundColor Yellow
        }
    }
    Write-Host "Log: docker compose logs -f consumer predictor integration-hub"
} finally {
    Pop-Location
}
