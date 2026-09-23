# ADR 0034 — Painel comanda pela API, servido do último build que passou (emenda o ADR 0013)

**Status:** Aceito (decisão do plano da v5 aprovado por Erick, 2026-09-23)

## Contexto

O [ADR 0013](0013-painel-projecao-takeover-por-comando-pty-depois.md) fixou o painel como projeção: ele lê o estado
e só age por comando. A v5 leva ao painel o caminho do pedido até a aprovação, o chat com cópia do projeto e as opções
de missão, e passa a abrir vários projetos no mesmo servidor. O [ADR 0030](0030-typescript-no-motor-e-build-do-painel.md)
fixou o build do painel em `packages/web` (React 19 + TypeScript + Vite). ADR aceito não se edita; este emenda o 0013.

## Decisão

1. **O painel comanda pela API.** Pedido, chat, opções e projetos abertos são rotas sob `/api/` do servidor local,
   atrás da mesma checagem de sessão (`x-ade-session`) e de origem do ADR 0013; a escrita passa sempre pelo journal
   ou por portas injetáveis em `startServer({ deps })`, nunca direto pela tela.
2. **Vários projetos no mesmo servidor.** Cada projeto aberto tem o próprio serve-lease; abrir um projeto cujo lease
   está com outro servidor responde 409. Fechar responde 409 e conserva o lease enquanto houver atividade em execução
   (missão ou turno de chat) registrada por `beginActivity(projectId, kind)`.
3. **Servido do último build que passou.** `npm run build:web` compila em `packages/web/dist/builds/<carimbo>/` e só
   depois de a checagem de tipos e o vite build passarem grava `packages/web/dist/current.json` por arquivo temporário
   + rename. O servidor relê o ponteiro a cada pedido, então a troca não tem intervalo sem painel; build ou promoção
   que falha remove só a pasta nova e deixa o ponteiro anterior intacto. Ficam o build atual e o anterior.
4. **Fallback.** Sem build promovido válido, o servidor entrega o `index.html` da raiz, como antes.

## Consequências

- Caminho de tela sem `/api` recebe o `index.html` do build (SPA); caminho que sai da pasta do build recebe 404.
- As provas de interface rodam o painel no chromium do Playwright dentro do vitest (`tests/helpers/panel_ui.ts`);
  chromium ausente faz a prova falhar com mensagem clara, nunca ser pulada.

## Como reverter

Apagar `packages/web/dist/current.json` volta o servidor ao `index.html` da raiz sem outra mudança.
