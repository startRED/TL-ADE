# ADR 0023 — JS ESM com JSDoc e `checkJs`: portão de tipos sem build (emenda o ADR 0001)

**Status:** proposto, pendente de confirmação do Erick

## Contexto

O ADR 0001 previa TypeScript estrito como linguagem de implementação de todo o código. No entanto,
a fundação já entregue no repositório foi construída em `src/**/*.js` ESM com JSDoc e testes em `tests/**/*.test.ts`.
O binário `ade` precisa rodar diretamente com `node` sem passo intermediário de compilação ou build,
garantindo inicialização imediata e rastreamento direto de erros. Além disso, a invocação via `npx` falha
com EINVAL no Windows (ADR 0022), reforçando a necessidade de execução direta com o runtime Node.

## Decisão

Adotar formalmente JavaScript ESM com tipagem estrita via anotações JSDoc para todo o código de produção
e TypeScript nos testes, mantendo a integridade estática sem impor cerimônia de build:

1. **Produção em `src/**/*.js` ESM com JSDoc:** nenhum arquivo de produção é compilado; todos rodam diretamente no Node 22+.
2. **Testes em `tests/**/*.test.ts`:** suíte de testes mantida em TypeScript executada pelo Vitest.
3. **Portão de tipos com `allowJs`/`checkJs`/`strict`:** verificação estática contínua via comando `node node_modules/typescript/bin/tsc --noEmit`.
4. **Sem passo de build para o binário `ade`:** distribuição e execução direta pelo executável do Node.
5. **Leitura dos planos:** onde os documentos de planejamento e specs (como `docs/plans/slice-1.md`) dizem `src/...ts`, lê-se `.js`.

Este ADR emenda o ADR 0001 sem editá-lo; o restante do 0001 (Node ≥ 22, ESM, pacote único, dependências) segue valendo.

## Evidência

- `tsconfig.json` da raiz já configurado com `allowJs: true`, `checkJs: true` e flags estritas do TypeScript.
- `tests/gates.test.ts` valida o portão de tipos sem build executando `tsc --noEmit`.
- Digest #30 documenta o erro EINVAL ao tentar invocar shims `.cmd` como `npx.cmd` sem shell no Windows.
- O código de `src/` já foi entregue em `.js` com 100% dos testes verdes e tipagem validada.

## Trade-offs

JSDoc é mais verboso que sintaxe TS pura e tipos complexos pedem `@typedef` dedicados. Em contrapartida,
o ganho é zero build (eliminação completa do pipeline de compilação antes da execução), e qualquer stack
trace em desenvolvimento ou produção aponta diretamente para o arquivo e linha reais do código-fonte.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| Converter `src/` para `.ts` com build `tsc` | Adiciona etapa de compilação lenta e intermediária para gerar os artefatos do binário `ade` |
| Rodar `.ts` com loader (tsx/ts-node) | Sobrecarga de inicialização a cada invocação e risco de incompatibilidades com shims no Windows |
| Type stripping nativo do Node (instável no Node 22) | Recurso experimental e instável na linha Node 22, inadequado para motor durável |
| JS sem checagem de tipos | Perda de garantia de tipos estática na fronteira de módulos e regressão de robustez |

## Como reverter

Gatilho: a anotação via JSDoc virar um gargalo medido de produtividade ou expressividade no porte.
Custo: renomear arquivos de `src/**/*.js` para `.ts`, acrescentar etapa formal de build no `package.json`
e abrir um novo ADR revogando ou substituindo esta emenda.

## Consequências para outros documentos

- `docs/plans/slice-1.md` (§2 e §3): caminhos citados como `src/...ts` passam a ser lidos como `.js`.
- `AGENTS.md` e `PROJECT_CHARTER.md`: diretrizes de implementação passam a refletir JS ESM + JSDoc.
- `docs/roadmap.md` (§1): marcos de desenvolvimento contam com ausência de passo de build na raiz.
- `docs/adr/0001-typescript-node-monorepo.md`: emendado formalmente por este registro, permanecendo byte a byte inalterado.
