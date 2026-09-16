@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias pela primeira vez...
  call npm run setup
)
if not exist example\node_modules (
  call npm install --prefix example
)
set N=%1
if "%N%"=="" set N=1
set /a ADE_PORT=4316+%N%
set /a ADE_UI_PORT=5172+%N%
echo TL-ADE instancia %N%: servidor %ADE_PORT%, painel %ADE_UI_PORT%
start "TL-ADE servidor %N%" cmd /k node server.mjs
timeout /t 2 /nobreak >nul
call npx vite --open
