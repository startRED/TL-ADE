# Ponto de virada — projeto de exemplo

Projeto Node mínimo usado pelo `ade dogfood`. O pedido fixo está em `PEDIDO.md`; a prova
`test/nomes.test.mjs` nasce vermelha e fica verde quando o pedido é entregue.

```bash
npm test                                   # prova do exemplo (node:test)
node bin/ade.js dogfood --example examples/ponto-de-virada --out docs/operations/ponto-de-virada.md
node bin/ade.js dogfood --example examples/ponto-de-virada --out /tmp/pv.md --double   # sem rede, com dublês
```

O comando copia esta pasta para uma pasta temporária com git; esta pasta nunca é alterada.
