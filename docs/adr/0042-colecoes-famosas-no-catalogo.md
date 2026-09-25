# ADR 0042 — Coleções famosas no catálogo por lista curada no repositório (emenda os ADRs 0039 e 0009)

**Status:** Aceito (pedido de Erick, 2026-09-25: catálogo maior com as skills e plugins mais conhecidos, filtro rígido
de licença e lista fixa revisada que atualiza por comando)

## Contexto

1. O ADR 0009 fixou o catálogo curado com pins em `catalog.sources` da configuração, e o ADR 0039 ativou oito fontes
   pinadas em `~/.ade/catalog-repos/.ade/config.json`. Essa lista mora fora do repositório: não passa por revisão de
   código, não tem histórico e não diz por que cada fonte entrou.
2. As coleções mais usadas da comunidade (`obra/superpowers`, `affaan-m/ECC`, `anthropics/skills`,
   `addyosmani/agent-skills`) ficavam de fora ou dormentes até pin (`docs/catalog-sources.md` §1).
3. O operador quer filtro rígido (licença livre e segura) e catálogo que só muda quando alguém revisa a lista e roda o
   comando, nunca sozinho.

## Decisão

1. **A lista curada vive no repositório**, em `docs/catalog/fontes-curadas.json`, no mesmo formato de
   `catalog.sources` (nome, url, commit completo, licença, caminhos). Muda só por commit revisado.
2. **`ade catalog sync --sources <arquivo>`** lê a lista desse arquivo e substitui só `catalog.sources`; o resto da
   configuração (`trust_default`) segue a do projeto. `repo` ausente ou com `~/` aponta para
   `~/.ade/catalog-repos/<nome>`. Sem `--sources`, o sync segue lendo a configuração como no ADR 0039.
3. **Motivo e sinal da comunidade são obrigatórios na lista**: cada entrada leva `reason` (por que entrou e o que ficou
   de fora) e `community_signal` (estrelas/forks com a data da medição). A prova da lista
   (`tests/catalog_curated_sources.test.ts`) falha se uma entrada vier sem eles; o sync os copia para o índice e
   `ade catalog inspect` os mostra.
4. **Filtro rígido**: licença livre conferida no commit pinado (na raiz ou por skill quando a raiz não tem), só pastas
   de skill sem scripts nem hooks, e o SkillGuard de sempre decide liberada ou quarentena. Pin é commit completo; nada
   de `pull`.
5. **O registro humano é `docs/catalog-sources.md` §1.2**, com commit abreviado e licença iguais aos do arquivo; a
   prova `tests/catalog_sources_registry.test.ts` confere os dois sem rede.

## O que emenda

- **ADR 0009**: a fonte de pins deixa de ser só `catalog.sources` da configuração; a lista versionada no repositório,
  passada por `--sources`, é a forma recomendada para as coleções famosas. Os 12 controles do SkillGuard não mudam.
- **ADR 0039**: as fontes ativas da §1.1 continuam valendo; as coleções da §1.2 somam-se a elas pela lista curada.
  A escolha de skills por parte pelo plano não muda.

Os textos dos ADRs 0009 e 0039 não foram editados; esta emenda vale por cima deles.

## Consequências

- Catálogo maior (quatro coleções novas, 53 pastas de skill) sem instalador de registry aberto.
- Atualizar uma coleção é trocar o commit e a licença no JSON e na §1.2 no mesmo commit; a prova falha se um dos dois
  ficar para trás.
- Medir o sinal da comunidade de novo exige rede; a data no `community_signal` diz quão velho ele está.

## Como reverter

1. Rodar `ade catalog sync` sem `--sources` (volta a ler só `catalog.sources` da configuração) com `--rebuild-index`,
   o que tira do índice as skills das coleções da §1.2.
2. Para desfazer de vez, reverter o commit que adicionou `docs/catalog/fontes-curadas.json` e a opção `--sources`
   (`git revert`), apagar a §1.2 de `docs/catalog-sources.md` e marcar este ADR como **Substituído**. Os ADRs 0009 e
   0039 voltam a valer sozinhos, sem edição.
