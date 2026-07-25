@echo off
setlocal
chcp 65001 >nul
title Proma Windows Packager

cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Bun was not found in PATH.
  echo Install Bun and reopen this file.
  echo.
  pause
  exit /b 1
)

bun run apps/electron/scripts/package-windows.ts
set "PACKAGE_EXIT_CODE=%ERRORLEVEL%"

if "%PACKAGE_EXIT_CODE%"=="0" (
  echo.
  if exist "%~dp0apps\electron\out" (
    echo Opening package output directory...
    start "" "%~dp0apps\electron\out"
  ) else (
    echo Package completed, but the output directory was not found.
  )
) else (
  echo.
  echo Packaging failed. Review the error above.
)

echo.
pause
exit /b %PACKAGE_EXIT_CODE%
