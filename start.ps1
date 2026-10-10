param(
    [ValidateSet("demo", "field")][string]$Mode = "demo",
    [switch]$Orchestration
)
$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker CLI is unavailable. Install or start Docker Desktop, then open a new terminal."
    }
    docker info *> $null
    if ($LASTEXITCODE -ne 0) { throw "Docker engine is unavailable. Start Docker Desktop." }
    if (-not (Test-Path -LiteralPath ".env")) {
        Copy-Item -LiteralPath ".env.example" -Destination ".env"
        Write-Host ".env created from the lab configuration." -ForegroundColor Cyan
    }
    $composeArgs = @("compose")
    if ($Mode -eq "demo") { $composeArgs += @("--profile", "demo") }
    if ($Orchestration) { $composeArgs += @("--profile", "orchestration") }
    & docker @composeArgs config --quiet
    if ($LASTEXITCODE -ne 0) { throw "Invalid Compose configuration." }
    if ($Mode -eq "field") {
        & docker compose --profile demo stop simulator
        if ($LASTEXITCODE -ne 0) { throw "Could not stop the simulator for field mode." }
    }
    & docker @composeArgs up --build -d --wait --wait-timeout 180
    if ($LASTEXITCODE -ne 0) { throw "Startup health check failed. See: docker compose logs --tail 100" }
    Write-Host "Stack running (mode $Mode). Measured rules are available while the model warms up." -ForegroundColor Green
    Write-Host "Strata Console http://localhost:8082/ | Grafana http://localhost:3000"
    Write-Host "Hub API http://localhost:8082/docs | AI setup: docs/AI_CONSOLE.md"
    Write-Host "MinIO http://localhost:9001 | MLflow http://localhost:5000"
    Write-Host "Model http://localhost:8081/docs | Prometheus http://localhost:9090"
    Write-Host "Train after collecting data: .\train.ps1"
    if ($Orchestration) { Write-Host "Airflow http://localhost:8080 (enable the telco_data_pipeline DAG)" }
} finally {
    Pop-Location
}
