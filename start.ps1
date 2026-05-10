$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir
Write-Host "Installing dependencies if needed..."
pnpm install --silent
Write-Host "Starting dev server..."
pnpm run dev
