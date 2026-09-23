#!/bin/sh
# uso: gen.sh <nome> : gera .impeccable/mocks/decision/<nome>.png a partir de .impeccable/prompts/<nome>.txt
cd "$(dirname "$0")/.." || exit 1
CB="C:/Users/Erick/.ade-tools/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe"
"$CB" exec -c windows.sandbox=unelevated --skip-git-repo-check -s workspace-write -m gpt-5.6-luna -c model_reasoning_effort=low \
  "Use your image generation tool to create ONE landscape image. The image prompt is the full content of the file .impeccable/prompts/$1.txt: read that file and pass its text verbatim as the prompt. After the image is generated, copy the generated PNG to .impeccable/mocks/decision/$1.png with a shell command (the folder exists). Print only the final path." < /dev/null > ".impeccable/prompts/$1.log" 2>&1
ls -la ".impeccable/mocks/decision/$1.png"
