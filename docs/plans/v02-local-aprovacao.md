# Consulta e registro de aprovação da proposta local v0.2

Estado: **consulta válida; D1–D6 e minuta_adr_0024 pendentes**.

proposta_sha256: `dd86d0aed682a67499d91005f1ee8d26e201e3603a67ac8ad816f4e1ba276de5`

Este registro vincula todas as respostas ao blob submetido abaixo. A resposta do operador é insumo
humano obrigatório; fixtures de teste não constituem autorização. Uma resposta inequívoca pode herdar
o hash pelo vínculo verificável com a mensagem de origem, sem exigir que Erick o digite novamente.

Se o blob contiver qualquer delimitador reservado, ele não será submetido e o registro deverá conter
literalmente: `consulta inválida: delimitador presente na proposta`.

Ausência, resposta parcial ou hash divergente mantém os itens não autorizados bloqueados.
Mudança solicitada não aprova a versão alterada: o blob submetido é preservado e a alteração fica pendente para
uma nova proposta, um novo hash e uma nova consulta. Nenhuma mudança dependente pode começar antes da
resposta aplicável e do fechamento comprovado do Slice 1.

## Decisões D1–D6

| id | estado | resposta literal | origem | data | proposta_sha256 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| D1 | pendente | não recebida | não recebida | não recebida | dd86d0aed682a67499d91005f1ee8d26e201e3603a67ac8ad816f4e1ba276de5 |
| D2 | pendente | não recebida | não recebida | não recebida | dd86d0aed682a67499d91005f1ee8d26e201e3603a67ac8ad816f4e1ba276de5 |
| D3 | pendente | não recebida | não recebida | não recebida | dd86d0aed682a67499d91005f1ee8d26e201e3603a67ac8ad816f4e1ba276de5 |
| D4 | pendente | não recebida | não recebida | não recebida | dd86d0aed682a67499d91005f1ee8d26e201e3603a67ac8ad816f4e1ba276de5 |
| D5 | pendente | não recebida | não recebida | não recebida | dd86d0aed682a67499d91005f1ee8d26e201e3603a67ac8ad816f4e1ba276de5 |
| D6 | pendente | não recebida | não recebida | não recebida | dd86d0aed682a67499d91005f1ee8d26e201e3603a67ac8ad816f4e1ba276de5 |

## Aprovação separada da minuta

| id | estado | resposta literal | origem | data | proposta_sha256 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| minuta_adr_0024 | pendente | não recebida | não recebida | não recebida | dd86d0aed682a67499d91005f1ee8d26e201e3603a67ac8ad816f4e1ba276de5 |

## Consulta única a Erick

Erick, responda conjuntamente sobre D1–D6 para esta proposta e aprove ou recuse expressamente, em item
separado, a minuta do ADR 0024. Para D6, identifique a fonte oficial do percentual, a janela semanal e
seu reinício, confirme que o consumo externo à missão entra no total e determine o bloqueio quando os
dados estiverem ausentes, desatualizados ou ambíguos. As escolhas gerais da entrevista não aprovam estas
mudanças detalhadas. Mudanças dependentes aguardam sua resposta vinculada ao hash acima e o fechamento
comprovado do Slice 1.

Conteúdo integral submetido:

<!-- proposta:utf8:inicio -->
# Proposta não autorizada de revisão integrada local

Estado: **proposta não autorizada; todas as decisões permanecem pendentes**.

Este documento prepara uma possível emenda de rumo. Ele não é um ADR aceito, não altera a Carta do
Projeto, não ativa revisão integrada e não autoriza chamadas pagas. A fonte de verdade vigente continua
sendo a arquitetura e os ADRs já aceitos. Qualquer conflito abaixo é levado a Erick para decisão, sem ser
resolvido por esta proposta.

## Escopo

O recorte proposto é **revisão integrada local**: revisão Codex somente leitura, resultado validado contra
o contrato aprovado, rework limitado executado pelo Maker e entrega local. O resultado possível termina
em commit isolado ou integração local nas condições de D4.

Limites explícitos do recorte:

- push: fora do recorte;
- PR: fora do recorte;
- merge remoto: fora do recorte;
- D2 remoto: fora do recorte.

Este recorte é separado tanto do **Slice 1** quanto da **v0.2 completa**. Ele não fecha o Slice 1, não
declara D2 e não equivale à conclusão da v0.2. A paridade **93/93** em Windows e Linux e todas as demais
obrigações de `docs/roadmap.md` §2 continuam metas próprias da v0.2 completa. Em particular, continuam
fora desta autorização os invariantes restantes, a entrega até PR merged, os contratos enriquecidos de
resultado, o preflight, o plano de verificação, a classe de mudança do plano de controle, a projeção
documental e o orçamento de cota no motor. Nenhuma dessas obrigações é dispensada ou declarada pronta.

O estado consumido de `docs/plans/slice-1-fechamento.md` é **fechamento pendente**. Suas lacunas são
pré-condições para autorizar implementação, nunca dispensas:

- falta relatório rastreável do conjunto completo no Windows e no Linux para o commit atual;
- falta cobertura comprovada de pelo menos 85% nos seis módulos de durabilidade;
- faltam coleta reproduzível e replanejamento explícito da medição de porte;
- faltam doze testes dedicados para as células normativas de crash;
- faltam `ade doctor` real, capability-set e provas de `json-schema` e `session-id` atuais;
- faltam canário por família e prova de recusa da família sem canário;
- falta o cenário combinado de segredo, escopo e diff maior que 1 MiB;
- o dogfood D1 não prova os gates dentro do motor nem identifica os dois sistemas;
- `first_source_edit_ms` segue indisponível; e
- a divergência nominal 44 versus 45 permanece aberta.

## Restrições comuns

Se houver autorização futura, todos os épicos derivados herdam este registro comum:

- partes próximas de 300 linhas com prova própria;
- eval antes do código;
- produção em `src/**/*.js` ESM com JSDoc e testes em `tests/**/*.test.ts`;
- textos e comentários em português, com `strict` e lint preservados;
- somente `ajv` e `canonicalize` como dependências de produção;
- modelos acessados por CLIs instaladas, sem APIs HTTP de modelos;
- erros lançados como subclasses de `AdeError` com `exitCode`;
- processos sem `shell` e com `maxBuffer` explícito;
- `proto/**` preservado;
- os oito `schemas/*.schema.json` preservados;
- a allowlist de `tests/meta.test.ts` preservada;
- pacote único preservado, sem `workspaces` nem `packages/`;
- nenhum `npx`, `git push` ou operação remota nas receitas; e
- nenhuma supressão de tipo ou lint e nenhum afrouxamento de `strict`.

Antes de qualquer commit, o registro de prova deve identificar commit completo e sistema operacional e
mostrar **saída 0 antes de qualquer commit** para estes três comandos exatos:

```text
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
npm run lint
```

As receitas de cada parte executam apenas sua prova focal. As provas documentais verificam completude,
vínculos e bloqueios com dados locais e casos negativos; não se apresentam como execução real do motor
em Windows e Linux. Evidência histórica não é promovida automaticamente ao commit atual.

## Decisões D1–D6

As seis decisões formam uma consulta única. Aprovar parte da consulta, silenciar ou aprovar uma versão
anterior não autoriza os itens restantes.

### D1 — Julgamento imutável

**Recomendação:** congelar os critérios aprovados e o plano de verificação associado antes da
implementação. Os critérios aprovados imutáveis são a referência de julgamento. O executor pode relatar
`ready_for_verification`, mas opera sem autoaprovação e sem relaxamento de critério, teste ou evidência.

**Alternativa:** manter a regra vigente sem ampliação: não integrar Checker ao fluxo e continuar com os
gates locais e a decisão humana já exigidos.

**Motivo:** separar execução de julgamento impede que o agente transforme dificuldade de implementação
em redefinição silenciosa do sucesso.

**Risco:** um critério ambíguo fica bloqueante até decisão humana; permitir interpretação pelo executor
produziria aprovação circular.

**Alterações dependentes:** qualquer implementação futura do contrato de revisão, plano de verificação,
estado `ready_for_verification` ou transição de aprovação.

**Dependências:** fechamento comprovado do Slice 1, contrato aprovado e digest imutável dos critérios.

**Estado inicial:** pendente de aprovação expressa de Erick.

### D2 — Mudança do plano de controle

**Recomendação:** classificar mudanças de regras, schemas, gates, CI, roteamento, `contain` e journal como
mudanças do plano de controle. Elas exigem revisão reforçada e aprovação humana antes de qualquer
alteração dependente; executor e revisora não podem dispensar esse portão.

**Alternativa:** manter a regra vigente sem ampliação: não implementar revisão integrada e conservar a
revisão humana obrigatória já existente nas superfícies críticas.

**Motivo:** essas superfícies mudam como todo trabalho posterior é permitido, registrado ou julgado.

**Risco:** uma mudança autoaprovada pode enfraquecer retroativamente contenção, prova, autorização ou
recuperação; o bloqueio humano pode aumentar latência legítima.

**Alterações dependentes:** alterações em `AGENTS*`, skills, schemas, framework de evals, configuração de
adapter, roteamento de modelo, gates, CI, `contain`, journal e políticas de aprovação.

**Dependências:** classificação determinística do diff, registro `control_plane_change`, revisão
reforçada e aprovação humana rastreável antes da mudança dependente.

**Estado inicial:** pendente de aprovação expressa de Erick.

### D3 — Revisora independente

**Recomendação:** executar a revisora em modo somente leitura, com `vendor` distinto do Maker e outro
`model_id`. A revisora emite resultado validado e nunca aplica o próprio rework; o Maker corrige dentro
do limite aprovado e uma nova revisão julga o resultado. Indisponibilidade de revisora elegível bloqueia
a aprovação.

**Alternativa:** manter a regra vigente sem ampliação: não despachar revisora integrada e entregar o
resultado local para revisão manual.

**Motivo:** independência por empresa e modelo reduz erro correlacionado e preserva a separação entre
quem produz, quem julga e quem corrige.

**Risco:** falta de outro vendor estaciona a story; um modo de leitura mal isolado poderia permitir efeito
indevido e precisa falhar fechado.

**Alterações dependentes:** seleção do Checker, validação de `vendor` e `model_id`, permissões somente
leitura, schema de resultado, loop de rework limitado e transição de aprovação.

**Dependências:** CapabilitySet observável, canário de isolamento válido, contrato congelado, resultado
validado e orçamento de rodadas.

**Estado inicial:** pendente de aprovação expressa de Erick.

### D4 — Integração exclusivamente local

**Recomendação:** permitir integração local `ff-only` somente quando a branch base estiver inalterada
desde `prepare` e todas as provas exigidas estiverem verdes, preservando a referência de origem em
`refs/ade/`. Se a base mudou, manter o commit isolado na branch da story e pedir decisão; não rebasear,
mesclar ou publicar automaticamente.

**Alternativa:** manter a regra vigente sem ampliação: sempre entregar o commit isolado ao operador, sem
integração local automática.

**Motivo:** aplica localmente a regra de arquitetura E64 sem alargar o recorte para entrega remota.

**Risco:** integrar sobre uma base alterada invalidaria as provas; referências não preservadas reduziriam
a capacidade de auditoria e reversão.

**Alterações dependentes:** detecção da base, gate final, operação `local_merge`, preservação em
`refs/ade/`, relatório e estado de espera por decisão.

**Dependências:** base inalterada, provas verdes, commit isolado e fechamento comprovado do Slice 1.

**Estado inicial:** pendente de aprovação expressa de Erick.

Origem: **E64** de `docs/architecture.md`. A entrega remota exigida pelo D2 do roadmap não é satisfeita
por esta integração local e continua fora do recorte.

### D5 — Terceira empresa somente como fallback

**Recomendação:** antecipar Google via `agy` exclusivamente como fallback de revisão quando a revisora
principal estiver indisponível. O despacho exige CLI instalada, canário de isolamento aprovado,
capacidade verificada e vendor distinto do Maker. Se qualquer condição for inviável, estacionar o
despacho pago; isso não impede a autorização documental da implementação.

**Alternativa:** manter a regra vigente sem ampliação: Google continua na v0.5 e a falta da revisora
principal bloqueia a aprovação local.

**Motivo:** oferece a terceira empresa escolhida por Erick sem transformá-la em Maker, transporte novo
ou backend HTTP.

**Risco:** antecipar uma família sem prova de isolamento ou capacidade amplia a superfície de execução;
sem fallback elegível, a disponibilidade diminui mas a segurança é preservada.

**Alterações dependentes:** registro de capacidade de `agy`, seleção de fallback, canário, validação de
vendor e estacionamento por indisponibilidade.

**Dependências:** CLI instalada, canário, capacidade verificada, identidade de vendor observável e D3
aprovada.

**Estado inicial:** pendente de aprovação expressa de Erick.

Conflito não resolvido: **arquitetura §9.2** fixa Google via `agy` na v0.5, enquanto esta proposta o
anteciparia para o recorte local de fallback. A origem operacional da integração local é E64, mas E64 não
autoriza essa antecipação. Erick precisa aprovar expressamente a mudança de fase.

### D6 — Teto semanal por assinatura

**Recomendação:** adotar teto absoluto de 50% por assinatura na janela semanal do provedor, medido por
uma fonte de percentual total exposta oficialmente pela CLI ou pela conta. A fonte deve declarar a janela
semanal e o instante de reinício definidos pelo provedor. A coleta ocorre antes de cada despacho, inclui
consumo externo à missão no total e aplica a regra de nenhuma soma entre assinaturas. O crescimento autorizado é de
pontos percentuais do plano, não de tokens ou dólares.

A autorização segue sem renovação automática ao virar a semana. Fonte ausente, desatualizada, ambígua ou
sem reserva capaz de assegurar o teto bloqueia novas chamadas pagas. A regra é: tokens e dólares permanecem telemetria sem conversão.

Exemplos normativos:

- fonte oficial informa consumo total semanal inicial de 40% e há crescimento posterior de 10 pontos:
  **40% + 10 pontos percentuais = 50%; restante = 0%**;
- `fonte = null`: **cota indisponível; execução paga bloqueada**.

**Alternativa:** manter a regra vigente sem ampliação: não fazer novos despachos pagos quando não houver
uma fonte oficial adequada, sem implementar aproximação por tokens, dólares ou soma de assinaturas.

**Motivo:** somente o percentual total da própria assinatura representa a escolha “metade da cota
semanal” e incorpora uso ocorrido fora desta missão.

**Risco:** o provedor pode não expor dado atual ou reserva; falhar fechado reduz disponibilidade. Uma
estimativa inventada poderia ultrapassar o limite real.

**Alterações dependentes:** coleta de cota, reserva anterior ao despacho, journal por chamada, scheduler,
relatório, bloqueio e política de reinício semanal.

**Dependências:** fonte oficial identificada, atualidade verificável, janela e reinício declarados,
reserva conservadora e aprovação da interpretação por assinatura.

**Estado inicial:** pendente de aprovação expressa de Erick.

Conflito não resolvido: **E69** põe contadores de cota fora da v1; **arquitetura §9.8** exige mostrar uso
do plano e manda exibir indisponibilidade sem fonte; **roadmap §2, item 15** põe cota como orçamento de
primeira classe na v0.2 usando `quota_tokens`. A proposta não escolhe silenciosamente entre percentual
oficial e tokens internos: exige aprovação explícita para o percentual por assinatura e mantém tokens
apenas como telemetria.

## Minuta de ADR 0024

### ADR 0024 — Revisão integrada local, controle humano e cota por assinatura

**Status:** minuta não autorizada, pendente de aprovação expressa de Erick para o mesmo hash da proposta.

### Contexto

O Slice 1 ainda tem fechamento pendente, e a v0.2 vigente combina Checker, entrega remota, alterações do
plano de controle e orçamento de cota. Erick escolheu avançar somente a próxima fase, no computador local,
com outra empresa como fallback e teto de metade da cota semanal por assinatura. O teto de planejamento
de `docs/roadmap.md` §11 proíbe gravar novo ADR antes do fechamento comprovado do Slice 1; por isso este
texto é apenas a `minuta_adr_0024` e não foi criado em `docs/adr/`.

### Decisão

Se e somente se as condições de ativação forem satisfeitas, adotar conjuntamente D1–D6 desta proposta:
critérios imutáveis; revisão humana reforçada do plano de controle; revisora independente somente leitura;
integração local `ff-only`; Google via `agy` apenas como fallback condicionado; e teto de 50% do consumo
semanal total por assinatura obtido de fonte oficial. Esta decisão não autoriza push, PR, merge remoto,
D2 remoto nem a conclusão da v0.2.

Esta minuta emenda, sem editar, os ADRs 0003, 0005, 0006, 0012, 0015, 0017, 0020 e 0023 nos pontos em que
paridade, famílias, Checker, worktree, autonomia, doctor, método e linguagem condicionam o recorte.

### Evidência

- `docs/plans/slice-1-fechamento.md`: fechamento e lacunas atuais.
- `docs/architecture.md` §9.2 e §9.8, E64 e E69: famílias, cota, integração local e conflito de fase.
- `docs/roadmap.md` §2, item 15, e §11: orçamento de cota e teto de planejamento.
- `docs/development-method.md`: eval-first, gates antes do commit e revisão humana de superfícies críticas.
- Escolhas registradas na entrevista: próxima fase, somente local, metade semanal por assinatura, decisões
  críticas reunidas, Windows e Linux e outra empresa para fallback.
- [hipótese] a CLI ou conta de cada provedor expõe percentual total semanal, janela e reinício com
  atualidade suficiente para reservar o despacho.
- [hipótese] existe capacidade disponível do vendor alternativo para cumprir a revisão sem exceder a cota.

### Trade-offs

O recorte permite validar a integração sem efeitos remotos e reduz correlação entre Maker e revisora. Em
troca, falha fechado quando base, revisora, isolamento, capacidade ou cota não podem ser provados; também
exige uma aprovação conjunta antes de implementar e outra barreira operacional antes do despacho pago.

### Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| Implementar o Checker nesta rodada | Autorizar escopo precede implementação; esta entrega é documental |
| Tratar o recorte como v0.2 completa ou D2 | O recorte não inclui entrega remota nem todas as obrigações da versão |
| Permitir autoaprovação ou rework pela revisora | Mistura executor, julgador e corretor |
| Somar assinaturas ou converter tokens/dólares em percentual | Não mede percentual total do plano escolhido |
| Renovar automaticamente o teto na virada semanal | A autorização é específica e não se renova por relógio |
| Fazer merge local com base alterada | As provas deixam de corresponder ao estado integrado |

### Como reverter

Antes da implementação, rejeitar esta minuta mantém integralmente as regras vigentes. Depois de eventual
aceite e implementação, o gatilho de reversão é uma revisão que deixa de ser independente, uma integração
local sem rastreabilidade, uma fonte de cota não confiável ou custo/bloqueio operacional incompatível com
a meta. A reversão desativa despacho e integração automática, preserva journal, commits e `refs/ade/`, e
exige novo ADR; nunca reescreve o ADR aceito.

### Consequências para outros documentos

- Um ADR 0024 só poderá ser gravado depois do fechamento comprovado do Slice 1 e da aprovação desta
  minuta para o mesmo hash.
- `docs/architecture.md`, `docs/roadmap.md` e a Carta não são alterados por esta proposta.
- Épicos futuros poderão propor implementação do Checker, orçamento e integração, cada um com prova
  própria; nenhuma funcionalidade é ativada por esta minuta.
- Os conflitos de D5 e D6 permanecem explícitos até decisão de Erick.

## Condições de ativação

### Autorização documental da implementação

A implementação só pode ser autorizada quando ocorrerem, juntas:

1. fechamento comprovado do Slice 1 conforme suas nove obrigações e requisitos adicionais;
2. aprovação expressa de D1, D2, D3, D4, D5 e D6;
3. aprovação expressa e separada da `minuta_adr_0024`; e
4. todas as aprovações vinculadas ao mesmo hash desta proposta.

Para congelar o objeto aprovado, o artefato de consulta contém o **blob UTF-8 integral** desta proposta e
um **SHA-256** calculado sobre seus bytes exatos. A resposta registra separadamente as decisões D1–D6 e a
`minuta_adr_0024`, sempre citando o mesmo hash. Silêncio, resposta parcial ou qualquer alteração posterior
do blob não autoriza itens pendentes; conteúdo alterado exige novo SHA-256 e nova aprovação.

O teto de planejamento de `docs/roadmap.md` §11 continua vigente até esse fechamento. Aprovar esta
expansão não substitui a prova de saída e não autoriza gravar o ADR, alterar a arquitetura ou implementar
o orçamento antes das condições acima.

### Habilitação de despacho pago posterior

As verificações de **CLI, canário, capacidade e fonte de cota** são separadas da autorização documental.
Elas não bloqueiam Erick de aprovar o recorte, mas são obrigatórias para qualquer **despacho pago
posterior**. Antes de ativar funcionalidade ou despachar, a implementação ainda precisa passar suas provas
focais, os três gates comuns, as provas exigidas de Windows e Linux e as validações de segurança,
permissões e aprovação aplicáveis. Ausência de qualquer verificação estaciona o despacho sem ampliar
autonomia e sem inferir autorização.

<!-- proposta:utf8:fim -->
