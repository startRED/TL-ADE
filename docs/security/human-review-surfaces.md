# Superfícies que continuam exigindo revisão humana (v1)

A v1 fecha com três superfícies em que diff nenhum entra sem revisão humana do Erick, mesmo com
todas as provas verdes. O modelo de ameaças está em `docs/security/README.md`; a regra de revisão
humana vem da exceção E30 e do ADR 0015 (`docs/security/contain-human-review.md`).

## 1. Contenção e isolamento

Fronteira que impede escrita fora do worktree, vazamento de segredo e expansão de escopo.

- `src/contain/contain.ts`: contenção pós-fato e quarentena da árvore;
- `src/contain/secrets.ts`: varredura de segredos no diff integral;
- `src/contain/canary.ts`: canário de isolamento;
- precondições `worktree_isolation` e `permitted_effects` da noite desatendida
  (`src/engine/preflight.js`, `src/cli/run.js`).

Por que humano: um falso negativo aqui não aparece em prova nenhuma; ele só vira incidente.

## 2. Servidor local do painel

O painel é projeção do journal; o único efeito é o takeover por comando.

- `src/panel/server.js`: escuta restrita a `127.0.0.1` e token de sessão (`x-ade-session`);
- `src/panel/session.js`, `src/panel/control.js`: sessão e takeover sob lease;
- `src/panel/websocket.js`: canal com o navegador.

Por que humano: qualquer rota nova é superfície de rede alcançável por outra página do mesmo
computador.

## 3. Ingestão do catálogo

Skills de terceiros entram no contexto dos agentes.

- `src/skills/catalog.js`: sincronização e digest do catálogo;
- `src/skills/skillguard.js`: inspeção e quarentena;
- `src/cli/catalog.js`: comando `ade catalog`.

Por que humano: prompt injection não tem defesa confiável; o que entra no catálogo é o que o agente
lê como instrução.

## Fora destas três

Calibração de limites (`ade report --calibrate`) só propõe; mudar `.ade/config.json` e portões é
plano de controle e também passa pelo operador, sem merge automático.
