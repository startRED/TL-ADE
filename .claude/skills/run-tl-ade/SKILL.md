---
name: run-tl-ade
description: Run, start, drive, screenshot or test the TL-ADE panel (ade serve, packages/web). Use to launch an isolated panel, click through the request flow (pedido, entrevista, Modelos), paste images, take screenshots, read the real panel's state, or restart the real panel on port 4173.
---

# Run TL-ADE

TL-ADE is a Node 24 backend (`bin/ade.js`, `src/**/*.ts` run without a build) that serves a React panel from `packages/web/dist`. Agents drive it with **`.claude/skills/run-tl-ade/driver.mjs`**. The driver starts an isolated panel, or attaches to a running one, opens headless Playwright Chromium at 1440×900, and runs commands read from stdin one per line.

All paths are relative to the repo root. The shell is Git Bash on Windows 11.

## Prerequisites

- Node 24, and `npm install` already done. Playwright 1.49 and its Chromium are already present; the panel tests use them.
- Never use `npx`: it fails with EINVAL on Windows (ADR 0022).

## Build

Only the front end has a build. After any edit in `packages/web/src`, rebuild, or the server keeps serving the old build:

```bash
npm run build:web
```

Success prints `Painel promovido: …\packages\web\dist\builds\<data>`.

## Run (agent path): the driver

### Isolated panel (default, safe)

The driver creates a scratch git repo and a scratch `~/.ade`, and calls `startServer` in-process. The interview is stubbed with one question ("Confirmar?"), so sending a request costs no model quota. The driver never reads plan quota.

```bash
node .claude/skills/run-tl-ade/driver.mjs <<'EOF'
shot 01-inicio
fill Pedido = Quero uma página de contato\ncom formulário e validação
paste-image Pedido
wait 500
shot 02-pedido-com-print
click Enviar pedido
wait 1500
shot 03-entrevista
quit
EOF
```

Screenshots land in `%TEMP%\tl-ade-shots\<nome>.png`; the driver prints the full path. Use `--out <pasta>` to change the folder.

### Attach to the real panel (read the live state)

This mode reads the live state and changes nothing unless you click something.

```bash
node .claude/skills/run-tl-ade/driver.mjs --url http://127.0.0.1:4173/ <<'EOF'
click Modelos
wait 3000
eval [...document.querySelectorAll('[data-testid^=quota-]')].map(e => e.innerText.replace(/\s+/g, ' ').slice(0, 60))
quit
EOF
```

This printed `["Claude 35% leitura oficial · renova 29/09, 05:00", …]`.

### Commands

| Command | Does |
|---|---|
| `goto <caminho>` | Navigates, relative to the panel URL. |
| `click <nome>` | Clicks the button, link or tab with that exact accessible name (`Enviar pedido`, `Modelos`, `Responder`, `Expandir campo`). |
| `fill <rótulo> = <texto>` | Fills the field with that exact label. `\n` becomes a line break. |
| `paste-image [rótulo]` | Pastes a generated PNG, the same path as Ctrl+V (default field: `Pedido`). |
| `shot <nome>` | Takes a screenshot. |
| `text` | Prints the first 3000 characters of the page text. |
| `eval <js>` | Prints the result of the JS expression as JSON. |
| `wait <ms>` | Waits. |
| `quit` | Closes the browser, stops the server and deletes the scratch folders. |

Other flags:

- `--repo <pasta git>` opens a specific repo instead of the scratch one.
- Lines starting with `#` are ignored.
- Errors print `falhou <cmd>: …` and the session continues.

## Direct invocation and tests

UI tests use `tests/helpers/panel_ui.ts` (`startPanelForTest` + `openPanel`), the same pattern as the driver. The three proof commands must exit 0 before any commit:

```bash
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
npm run lint
```

Run one file with `node node_modules/vitest/vitest.mjs run tests/panel_web_attachments.test.ts`, or filter tests with `-t "C3.6|C3.7"`.

## Run (human path): the real panel on 4173

Erick starts and stops the panel with the desktop shortcuts **Ligar TL-ADE** and **Desligar TL-ADE**. They run `~/.ade/atalhos/ligar-tl-ade.ps1` and `desligar-tl-ade.ps1`.

To restart the real panel after a backend change, use PowerShell:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bin.ade\.js.*serve' } | ForEach-Object { taskkill /T /F /PID $_.ProcessId | Out-Null }
$p = Start-Process node -ArgumentList 'bin/ade.js','serve','--repo','E:/Documentos/ProjetosIA/TL-ADE','--port','4173','--no-open' -WorkingDirectory 'E:\Documentos\ProjetosIA\TL-ADE' -WindowStyle Hidden -PassThru
$p.PriorityClass = 'BelowNormal'
```

Killing `serve` with `/T` also kills the claude, codex and agy processes a running mission started. The mission resumes when the panel starts again. Do not restart the panel mid-mission without reason.

## Gotchas

- **Check readiness on `127.0.0.1`, not `localhost`.** `localhost` tries IPv6 first, and the readiness check times out. The browser can still open `http://localhost:4173/`.
- **Serve lease is per repo** (`<repo>/.ade/serve.lease`). A second `ade serve` on the same repo exits with code 5. The driver's scratch repo avoids this. Do not pass `--repo` pointing at the TL-ADE repo while the real panel runs.
- **`ade serve` reads plan quota by itself** (`watchQuota`): at boot and every 3 minutes. The Claude read makes a minimal model call. Test servers and the driver leave it off; only the real panel should have it.
- **The panel serves the promoted build**, not the source. A UI edit without `npm run build:web` looks like "my change did nothing". The tests rebuild by themselves when the source is newer.
- **The Modelos page takes ~2–3 s** to leave "Lendo os modelos…". Use `wait 3000` before reading it.
- **Pass the driver's stdin through a quoted heredoc (`<<'EOF'`).** `printf` turns `\\n` inside `eval` code into real line breaks, which splits the command in two ("comando desconhecido").
- **Claude app browser pane:** when the app window is minimized, `document.hidden` is true, CSS transitions freeze, and screenshots time out. Screenshots from the driver's headless Chromium do not have this problem.
- **Never start a mission on the TL-ADE repo itself** from the scratch flow. A mission in the repo root can overwrite uncommitted edits. Commit first.

## Troubleshooting

| Symptom | Fix |
|---|---|
| The full suite fails in `mission-run`, `crash-matrix`, `review-convergence` or `evals` with timeouts. | These are load flakes. Run the file alone; it passes. Then rerun the whole suite. |
| `falhou click: … Timeout 10000ms` | The name is not exact, or the page has not rendered it yet. Run `text` to see the real names, add `wait 1000`, then retry. |
