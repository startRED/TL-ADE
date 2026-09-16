@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias pela primeira vez...
  call npm run setup
)
if not exist example\node_modules (
  call npm install --prefix example
)
start "TL-ADE servidor" cmd /k node server.mjs
timeout /t 2 /nobreak >nul
call npx vite --open
