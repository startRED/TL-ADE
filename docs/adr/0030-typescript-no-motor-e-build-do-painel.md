# ADR 0030 — TypeScript estrito no motor sem build e build do painel em `packages/web` (emenda os ADRs 0023 e 0027)

**Status:** Aceito (confirmado por Erick em 2026-09-22)

## Contexto

O [ADR 0023](0023-js-esm-com-jsdoc-e-checkjs.md) fixou a produção em `src/**/*.js` ESM com JSDoc e `checkJs`, porque na época
executar `.ts` exigia build ou loader. O [ADR 0027](0027-ativacao-da-v04b-painel-local.md) ativou o painel local sem compilação
e limitou os workspaces a `packages/web`.

O pedido da versão definitiva (`docs/plans/versao-definitiva.md`, seção Stack) pede "um stack muito bom": o Node 24 executa
`.ts` direto por remoção de tipos (type stripping nativo), o que tira o motivo do ADR 0023; e o painel completo da v5 parte do
painel da demo (`proto/src`, React), que precisa de compilação.

ADR aceito não se edita (`AGENTS.md`); este ADR emenda o 0023 e o 0027 sem alterar os arquivos deles.

## Decisão

1. **Backend em TypeScript estrito sem build.** Produção passa a `src/**/*.ts`, executada direto pelo Node 24
   (`engines.node >=24`). Imports relativos terminam em `.ts`. O `tsconfig.json` liga `allowImportingTsExtensions`,
   `erasableSyntaxOnly` e `noEmit`, e mantém `strict: true`. Só sintaxe apagável: nada de `enum`, `namespace` com valor,
   propriedades de parâmetro no construtor ou `import =`.
2. **Transição.** `.ts` e `.js` convivem em `src/` enquanto a migração da v2 anda por subsistema; o `tsconfig.json` inclui
   `src/**/*.ts` e `src/**/*.js` com `checkJs` e os `.js` restantes seguem com JSDoc até serem convertidos.
   `bin/ade.js` continua `.js` como entrada fina lida pelo npm; `src/visual/vendor/axe.min.js` é arquivo de terceiro.
3. **Frontend com build só em `packages/web`.** React 19 + TypeScript + Vite + Radix Themes e ícones Phosphor em
   `packages/web`. O build do front é portão: parte que quebra o build não passa. Nenhum outro lugar do repositório ganha
   passo de build, e `packages/web` continua o único workspace.
4. **O que não muda.** `npx` segue proibido (ADR 0022); todo `execFile`/`spawnSync` segue com `maxBuffer` explícito e sem
   `shell`; nenhuma supressão de tipo ou lint; `strict` não afrouxa; os comandos de prova continuam os mesmos.

## Evidência

- Node 24 executa `.ts` com remoção de tipos sem flag; o TypeScript 5.9 do repositório oferece `erasableSyntaxOnly` para
  recusar no typecheck a sintaxe que o Node não sabe apagar.
- `tests/docs_v2_typescript_adr.test.ts` prova, num projeto temporário que herda o `tsconfig.json` da raiz, que `.ts` importa
  `.js` e `.js` importa `.ts` sob `tsc --noEmit` e sob o Node, e que `enum` é recusado (TS1294).

## Trade-offs

- Sintaxe apagável apenas: sem `enum` e sem propriedades de parâmetro; uniões de literais e objetos `as const` cobrem o uso.
- Durante a transição há dois estilos de anotação (tipos em `.ts`, JSDoc em `.js`).
- O front passa a ter dependências de build (Vite) e um passo a mais no portão.

## Alternativas rejeitadas

- **Manter `.js` nos specifiers com `rewriteRelativeImportExtensions`:** exige emit, e o backend não tem build.
- **Reescrever o ADR 0023:** ADR aceito não se edita.
- **Loader de terceiro (tsx, ts-node):** dependência nova para o que o Node 24 já faz.

## Como reverter

Um ADR novo que emende este. Os `.ts` com sintaxe apagável viram `.js` com JSDoc removendo as anotações; o painel volta a
estático servindo o último build.

## Consequências para outros documentos

- `AGENTS.md`: convenções e proibições passam a `src/**/*.ts` com TypeScript estrito e build do front só em `packages/web`.
- `docs/adr/README.md`: índice e mapa de stack citam o 0030.
- `README.md` e `PROJECT_CHARTER.md`: a menção a JS ESM com JSDoc passa a citar a transição para TypeScript.
- `tsconfig.json`, `package.json` e `vitest.config.mjs`: aceitam `.ts` em `src/`.
