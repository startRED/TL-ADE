# Protótipo descartável da TL-ADE

Serve para sentir o produto antes de construir o motor durável. Não tem diário à prova de crash, não tem catálogo de skills, não tem painel de missões múltiplas. O código aqui é jogado fora quando o slice 1 chegar; o que ele ensina vira ajuste no plano.

## O que faz

1. Você digita um pedido em linguagem natural no painel (ex.: "o botão Entrar tem de ficar desabilitado enquanto o envio está em curso").
2. O servidor roda os testes do projeto de exemplo (`example/`) e grava a linha de base.
3. Chama o **Claude Code** em modo silencioso (`claude -p --output-format stream-json`) com o pedido e a regra "teste que falha antes, passa depois".
4. Roda os testes de novo e monta o diff.
5. Chama o **Codex** em modo somente leitura (`codex exec --json --sandbox read-only --output-schema`) para revisar o diff.
6. Mostra tudo ao vivo no painel e para em "aguardando você" se a revisão pedir mudanças ou algum teste ficar vermelho. Você aceita, pede mais uma rodada ou descarta.

## Rodar

Duplo clique em `abrir.bat`. Na primeira vez ele instala as dependências (1 a 2 minutos).

Ou, à mão:

```bash
npm run setup
npm run server
npm run ui
```

Precisa de `claude` e `codex` instalados e logados nas suas assinaturas. Cada rodada gasta chamadas reais.

## Onde ficam as coisas

- `server.mjs`: orquestração, API HTTP e eventos ao vivo (SSE). Grava `.ade/journal.jsonl`.
- `src/App.jsx`: painel (React + Radix Themes + Tailwind).
- `example/`: projeto alvo, com um bug de propósito.
- `review.schema.json`: formato da resposta do revisor.
