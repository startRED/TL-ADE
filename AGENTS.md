# TL-ADE — guia para agentes

## O que é

A TL-ADE é um scheduler durável, compilador de contexto e compilador de intenção para execução autônoma de missões por agentes de IA.
O Slice 1 entrega a execução via `ade run --plan` de uma story com garantias de durabilidade e integridade; ver `PROJECT_CHARTER.md`.

## Comandos de prova

```bash
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
npm run lint
```

Nunca use `npx`: `spawn('npx.cmd')` sem shell falha com EINVAL no Windows (ADR 0022). Os três saem 0 antes de qualquer commit.

## Convenções

- Produção em `src/**/*.ts` ESM com TypeScript estrito, executado direto pelo Node 24 sem build, imports relativos terminando em `.ts` e só sintaxe apagável (`erasableSyntaxOnly`) (ADR 0030, emenda o ADR 0023). Durante a migração, os `.js` restantes em `src/` seguem com JSDoc; `bin/ade.js` fica `.js`.
- Build só no front: React 19 + TypeScript + Vite em `packages/web`; o build do front é portão (ADR 0030, emenda o ADR 0027).
- Testes em `tests/**/*.test.ts`, um arquivo por módulo, nomes snake_case em inglês.
- Eval antes do código (a prova nasce vermelha).
- Todo `execFile`/`spawnSync` com `maxBuffer` explícito e sem `shell`.
- Erros lançados são subclasses de `AdeError` de `src/journal/errors.js` com `exitCode`.
- Dependências de produção: `ajv`, `canonicalize` e `better-sqlite3` (v0.4b, ADR 0027).
- Textos e comentários em português.

## Proibições

- Tocar `proto/**`; a demo fica intocada.
  - Exceção do épico "Servidor: chat escreve na cópia e rotas aprovar/recusar": podem ser alterados somente proto/chat-changes.mjs, proto/server.mjs, proto/chat-routes.test.mjs e proto/README.md.
  - Exceção do épico "Tela: cartão de permissão, travas e textos": podem ser criados ou alterados somente proto/src/diff-lines.mjs, proto/src/diff-lines.test.mjs, proto/src/PermissionCard.jsx, proto/src/permission-card.test.mjs, proto/src/App.jsx, proto/src/index.css e proto/README.md.
- Criar passo de build fora de `packages/web` (o backend roda sem build).
- Criar novos workspaces além de `packages/web` (v0.4b, ADR 0027).
- Suprimir regra de tipo ou lint (diretivas ts-ignore, ts-expect-error, ts-nocheck, oxlint-disable) ou afrouxar `strict`.
- Editar ADR aceito (abrir um novo que emenda).
- Alterar o formato dos 9 `schemas/*.schema.json` sem story própria.
- Criar item novo na raiz fora da allowlist de `tests/meta.test.ts`.
- `git push`.
- Pôr em `src/` item da lista "fora do recorte ativo da v0.4b" do charter.

## Leia antes

- Vai mexer em escopo → `PROJECT_CHARTER.md`
- Vai implementar story → `docs/plans/slice-1.md` §3
- Vai decidir arquitetura → `docs/adr/README.md`
- Dúvida de método ou portões → `docs/development-method.md`

Conhecimento condicional vai para `docs/reference/<cicatriz>.md` quando um agente errar, nunca para este arquivo.
