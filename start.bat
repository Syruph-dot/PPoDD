@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Installing dependencies if needed...
call pnpm install --silent
set "INSTALL_EXIT=%ERRORLEVEL%"
if not "%INSTALL_EXIT%"=="0" (
	echo pnpm install exited with code %INSTALL_EXIT% - aborting.
	exit /b %INSTALL_EXIT%
) else (
	echo Dependencies are installed/checked.
)

echo Starting dev server...
call pnpm run dev
