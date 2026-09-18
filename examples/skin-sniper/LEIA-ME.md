task: Descreva em uma frase clara a alteração pequena que a IA deve implementar no Skin Sniper.
scope_paths: Caminhos e globs dos arquivos permitidos para edição (ex.: src/**, tests/**).
do_not_touch: Caminhos protegidos que a IA não deve tocar (ex.: .ade/**, dependências, etc.).
evals.cmd: Comando do teste ou script de prova que valida a alteração implementada (ex.: node tests/check.mjs).
evidence: Arquivo(s) de evidência gerados pelo teste para comprovar o resultado da execução.
max_usd: Teto máximo de orçamento em dólares da missão (ex.: 3).
Rode: node <caminho-da-ADE>/bin/ade.js run --plan examples/skin-sniper/plan.json --repo <pasta-do-skin-sniper> — só commit local na branch ade/skin-sniper-m1/SKIN-1, nunca push.
