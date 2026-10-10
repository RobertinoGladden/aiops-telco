param([ValidateRange(1024,65535)][int]$Port = 8082)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
$taskPython = Join-Path $PSScriptRoot 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
    $taskPython = (Get-Command python -ErrorAction Stop).Source
}
Write-Host "Strata Console: http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host 'Sign in with INTEGRATION_API_TOKEN from .env. Ctrl+C stops the server.'
& $taskPython -m uvicorn integrations.hub:app --host 127.0.0.1 --port $Port
if ($LASTEXITCODE -ne 0) { throw 'Console startup failed. Check dependencies and the server port.' }
