# ADR 0037 — Tabela da missão em palavras, sem notação musical (emenda o ADR 0035)

**Status:** Aceito (Erick, 2026-09-23: "o que significa esses símbolos de música? não é claro o suficiente")

## Contexto

O [ADR 0035](0035-painel-com-sistema-visual-proprio-emenda-0030.md) desenhou a missão como partitura, com clave, pauta,
nota e pausa pela fonte Bravura. Quem pede não lê partitura: os símbolos precisavam de legenda para dizer o básico.

## Decisão

A grade continua (uma linha por papel, uma coluna por parte), mas cada casa diz em palavras o que o papel fez na parte
("escreveu", "prova passou", "revisou", "entregou", "na fila") com um ícone só (feito, falhou, rodando agora). Esforço
vira texto, a missão ganha número em vez de letra e o vocabulário de execução é "rodando", não "tocando". O resto do
mundo visual do 0035 (paletas, tipografia, gravuras, movimento) fica.

## Como reverter

Voltar `packages/web/src/Units.tsx` e o bloco "casas da tabela em palavras" de `app.css` ao commit anterior.
