@echo off
setlocal
cd /d "%~dp0"
set "LGA_NODE=%~dp0tools\node-v24.21.0-win-x64\node.exe"
if not exist "%LGA_NODE%" (
  echo Missing repository Node 24.21.0 runtime. Run tools\setup-node-win.ps1 first.
  exit /b 1
)
set "npm_config_cache=%~dp0.local\npm-cache"
set "ELECTRON_CACHE=%~dp0.local\ecs-cache"
set "ELECTRON_BUILDER_CACHE=%~dp0.local\builder-cache"
set "LGA_PACKAGE="
:args
if "%~1"=="" goto build
if "%~1"=="--no-run" goto next
if "%~1"=="--stage" (set "LGA_PACKAGE=stage" & goto next)
if "%~1"=="--prototype" (set "LGA_PACKAGE=prototype" & goto next)
if "%~1"=="--finalize" (set "LGA_PACKAGE=finalize" & goto next)
echo Unknown option: %~1
exit /b 1
:next
shift
goto args
:build
if "%LGA_PACKAGE%"=="finalize" goto package
if "%LGA_PACKAGE%"=="prototype" goto package
"%LGA_NODE%" "%~dp0node_modules\typescript\bin\tsc"
if errorlevel 1 exit /b 1
"%LGA_NODE%" "%~dp0scripts\copy-ui.mjs"
if errorlevel 1 exit /b 1
"%LGA_NODE%" "%~dp0scripts\pack-streamdeck.mjs"
if errorlevel 1 exit /b 1
if "%LGA_PACKAGE%"=="" exit /b 0
:package
"%LGA_NODE%" "%~dp0scripts\package.mjs" win %LGA_PACKAGE%
exit /b %errorlevel%
