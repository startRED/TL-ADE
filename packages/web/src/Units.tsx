import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Card, Flex, Heading, Text } from '@radix-ui/themes'
import { apiFetch, subscribeEvents } from './api.ts'

interface Step { name: string; state: string; at: string }
interface Unit { id: string; title: string | null; state: string; rounds: number; steps: Step[] }
interface Detail {
  id: string
  base_commit: string | null
  head_commit: string | null
  diff: Array<{ file: string; lines: Array<{ kind: 'add' | 'del' | 'ctx'; text: string }> }>
  tests: Array<{ name: string; status: 'passed' | 'failed' | 'red_at_start'; baseline_red: boolean }>
  review: { verdict: string; model_id: string | null; findings: Array<{ id: string; severity: string; text: string; status: string; citation: string | null }> } | null
}

const TEST_LABEL = { passed: 'passou', failed: 'falhou', red_at_start: 'vermelha na largada' } as const
const FINDING_LABEL: Record<string, string> = { open: 'aberto', withdrawn: 'retirado', resolved: 'resolvido' }
const DIFF_SIGN = { add: '+', del: '-', ctx: ' ' } as const
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
const hour = (at: string) => new Date(at).toLocaleTimeString('pt-BR')

/** Partes da missão; a aberta mostra passos, diff, provas e parecer, relidos a cada evento do journal. */
export default function MissionUnits({ projectId, missionId }: { projectId: string; missionId: string }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/missions/${encodeURIComponent(missionId)}/units`
  const [units, setUnits] = useState<Unit[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setUnits(await apiFetch<Unit[]>(base))
    if (openId) setDetail(await apiFetch<Detail>(`${base}/${encodeURIComponent(openId)}`))
  }, [base, openId])

  useEffect(() => {
    const reload = () => { load().then(() => setError(null), (err) => setError(messageOf(err))) }
    reload()
    return subscribeEvents(reload)
  }, [load])

  const open = units.find((u) => u.id === openId)
  return (
    <Flex direction="column" gap="3">
      <Heading as="h2" size="5">Partes de {missionId}</Heading>
      {error && <Text color="red" role="alert">{error}</Text>}
      <Flex direction="column" gap="2">
        {units.map((u) => (
          <Button key={u.id} variant={u.id === openId ? 'solid' : 'soft'} className="grow" aria-expanded={u.id === openId} onClick={() => setOpenId(u.id)}>
            {u.title ?? u.id} <Badge color="gray">{u.state}</Badge> <Text size="1">{u.rounds} rodada(s)</Text>
          </Button>
        ))}
      </Flex>
      {open && detail?.id === open.id && (
        <Card data-testid="unit-detail">
          <Flex direction="column" gap="3">
            <section>
              <Heading as="h3" size="3">Passos</Heading>
              <ol className="list">
                {open.steps.map((s) => (
                  <li key={s.name}><span className="mono">{s.name}</span> <Badge>{s.state}</Badge> <Text size="1" color="gray">{hour(s.at)}</Text></li>
                ))}
              </ol>
            </section>

            <section>
              <Heading as="h3" size="3">Diff</Heading>
              {detail.diff.length === 0
                ? <Text color="gray">Sem commit da parte ainda.</Text>
                : <Text size="1" color="gray" className="mono">{detail.base_commit?.slice(0, 8)}..{detail.head_commit?.slice(0, 8)}</Text>}
              {detail.diff.map((f) => (
                <div key={f.file} className="diff">
                  <Text as="p" weight="bold" className="mono">{f.file}</Text>
                  <pre>
                    {f.lines.map((l, i) => <div key={i} data-kind={l.kind} className={`diff-${l.kind}`}>{DIFF_SIGN[l.kind]}{l.text}</div>)}
                  </pre>
                </div>
              ))}
            </section>

            <section>
              <Heading as="h3" size="3">Provas</Heading>
              <TestList tests={detail.tests.filter((t) => !t.baseline_red)} />
              {detail.tests.some((t) => t.baseline_red) && (
                <>
                  <Text as="p" size="2" weight="bold">Vermelhas na largada</Text>
                  <TestList tests={detail.tests.filter((t) => t.baseline_red)} />
                </>
              )}
            </section>

            <section>
              <Heading as="h3" size="3">Parecer</Heading>
              {!detail.review
                ? <Text color="gray">Ainda sem revisão.</Text>
                : (
                  <>
                    <Text as="p"><Badge color={detail.review.verdict === 'approved' ? 'green' : 'orange'}>{detail.review.verdict}</Badge> revisor <span className="mono">{detail.review.model_id ?? 'desconhecido'}</span></Text>
                    <ul className="list">
                      {detail.review.findings.map((f) => (
                        <li key={f.id}>
                          <Badge color="gray">{f.severity}</Badge> {f.text} <Badge>{FINDING_LABEL[f.status] ?? f.status}</Badge>
                          {f.citation && <Text size="1" color="gray" className="mono"> {f.citation}</Text>}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
            </section>
          </Flex>
        </Card>
      )}
    </Flex>
  )
}

function TestList({ tests }: { tests: Detail['tests'] }) {
  if (tests.length === 0) return <Text as="p" color="gray">Nenhuma.</Text>
  return (
    <ul className="list">
      {tests.map((t) => (
        <li key={`${t.name}:${t.status}`}>
          <span className="mono">{t.name}</span> <Badge color={t.status === 'passed' ? 'green' : 'red'}>{TEST_LABEL[t.status]}</Badge>
        </li>
      ))}
    </ul>
  )
}
