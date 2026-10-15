@echo off
rem Disney Watch Party updater (Windows). Double-click this file.
cd /d "%~dp0"
set "FOLDER=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $dir=$env:FOLDER.TrimEnd('\'); Set-Location $dir; $ok=$false; if ((Test-Path '.git') -and (Get-Command git -ErrorAction SilentlyContinue)) { git pull --ff-only *> $null; if ($LASTEXITCODE -eq 0) { $ok=$true } }; if (-not $ok) { $tmp=Join-Path $env:TEMP ('dwp-'+[guid]::NewGuid()); New-Item -ItemType Directory $tmp | Out-Null; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing 'https://github.com/hcdonia/disney-watch-party/archive/refs/heads/main.zip' -OutFile (Join-Path $tmp 'dwp.zip'); Expand-Archive (Join-Path $tmp 'dwp.zip') -DestinationPath (Join-Path $tmp 'out') -Force; Copy-Item (Join-Path $tmp 'out\disney-watch-party-main\*') -Destination $dir -Recurse -Force } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue } }; $v=(Get-Content (Join-Path $dir 'manifest.json') -Raw | ConvertFrom-Json).version; Write-Host ''; Write-Host ('Updated to v'+$v+'. Last step: in the Chrome tab that just opened, click the refresh arrow on \"Disney Watch Party\", then reload your Disney+ tab.'); Write-Host ''"
if errorlevel 1 (
  echo.
  echo Sorry, the update did not work. Check your internet and try again.
  echo.
  pause
  exit /b 1
)
if not defined HWP_NO_OPEN (
  start chrome chrome://extensions 2>nul
  if errorlevel 1 echo Chrome did not open by itself. Open a new tab, type chrome://extensions and press Enter.
)
echo.
pause
