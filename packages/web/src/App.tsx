import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Badge, Box, Button, Card, Flex, Heading, IconButton, Switch, Text, TextField, Theme } from '@radix-ui/themes'
import { FolderOpen, FolderSimple, Moon, Sparkle, X } from '@phosphor-icons/react'
import { apiFetch, postJson, subscribeEvents } from './api.ts'
import IntakeFlow from './Intake.tsx'
import MissionUnits from './Units.tsx'

interface Project {
  id: string
  name: string
  path: string
  open: boolean
  active: boolean
}

interface Snapshot {
  missions: Array<{ id: string; status?: string }>
  selectedMission: { id: string; status?: string } | null
}

type Appearance = 'light' | 'dark'
type Page = 'home' | 'projects'

const APPEARANCE_KEY = 'ade.appearance'

function readAppearance(): Appearance {
  try {
    return localStorage.getItem(APPEARANCE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light' // armazenamento bloqueado: segue claro, sem lembrar a escolha
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export default function App() {
  const [appearance, setAppearance] = useState<Appearance>(readAppearance)
  const [projects, setProjects] = useState<Project[]>([])
  const [snapshot, setSnapshot] = useState<{ projectId: string; data: Snapshot } | null>(null)
  const [page, setPage] = useState<Page>('home')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const list = await apiFetch<Project[]>('/api/projects')
    setProjects(list)
    const active = list.find((p) => p.active)
    if (active) {
      const data = await apiFetch<Snapshot>(`/api/projects/${encodeURIComponent(active.id)}/snapshot`)
      setSnapshot({ projectId: active.id, data })
    }
  }, [])

  useEffect(() => {
    refresh().catch((err) => setError(messageOf(err)))
    return subscribeEvents(() => { refresh().catch((err) => setError(messageOf(err))) })
  }, [refresh])

  function toggleAppearance(dark: boolean) {
    const next: Appearance = dark ? 'dark' : 'light'
    setAppearance(next)
    try {
      localStorage.setItem(APPEARANCE_KEY, next)
    } catch {
      setError('O navegador não deixou guardar o modo noturno; ele vale só até recarregar.')
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const openProjects = projects.filter((p) => p.open)
  const active = openProjects.find((p) => p.active) ?? null
  const activeSnapshot = active && snapshot?.projectId === active.id ? snapshot.data : null

  return (
    <Theme appearance={appearance} accentColor="indigo" radius="large">
      <div className="shell">
        <nav className="sidebar" aria-label="Navegação">
          <Flex align="center" gap="2" className="brand">
            <Sparkle weight="fill" aria-hidden="true" />
            <Text weight="bold">TL-ADE</Text>
          </Flex>

          <Box>
            <Text as="p" size="1" color="gray" className="side-lbl">Projeto</Text>
            <Button variant="soft" className="proj-card" onClick={() => setPage('home')}>
              <FolderSimple weight="fill" aria-hidden="true" />
              <span data-testid="active-project">{active?.name ?? 'Nenhuma pasta'}</span>
            </Button>
          </Box>

          {openProjects.length > 0 && (
            <Box>
              <Text as="p" size="1" color="gray" className="side-lbl">Pastas abertas</Text>
              <Flex direction="column" gap="1">
                {openProjects.map((p) => (
                  <Flex key={p.id} align="center" gap="1">
                    <Button
                      variant={p.active ? 'solid' : 'ghost'}
                      className="grow"
                      aria-label={`Usar ${p.name}`}
                      title={p.path}
                      onClick={() => act(() => postJson('/api/projects/select', { id: p.id }))}
                    >
                      {p.name}
                    </Button>
                    <IconButton
                      variant="ghost"
                      color="gray"
                      aria-label={`Fechar ${p.name}`}
                      onClick={() => act(() => postJson('/api/projects/close', { id: p.id }))}
                    >
                      <X aria-hidden="true" />
                    </IconButton>
                  </Flex>
                ))}
              </Flex>
            </Box>
          )}

          <Flex direction="column" gap="3" className="side-foot">
            <Button variant={page === 'projects' ? 'solid' : 'soft'} onClick={() => setPage('projects')}>
              <FolderOpen aria-hidden="true" /> Projetos
            </Button>
            <Text as="label" size="2">
              <Flex gap="2" align="center">
                <Switch aria-label="Modo noturno" checked={appearance === 'dark'} onCheckedChange={toggleAppearance} />
                <Moon aria-hidden="true" /> Modo noturno
              </Flex>
            </Text>
          </Flex>
        </nav>

        <main className="main">
          {error && <Card className="warn" role="alert"><Text color="red">{error}</Text></Card>}
          {page === 'projects'
            ? <ProjectsPage projects={projects} onOpen={(dir) => act(async () => { await postJson('/api/projects/open', { path: dir }); setPage('home') })} />
            : <Home project={active} snapshot={activeSnapshot} />}
        </main>
      </div>
    </Theme>
  )
}

function Home({ project, snapshot }: { project: Project | null; snapshot: Snapshot | null }) {
  if (!project) {
    return <Heading as="h1" size="7">Abra uma pasta em Projetos para começar.</Heading>
  }
  const count = snapshot?.missions.length ?? 0
  return (
    <Flex direction="column" gap="4">
      <Heading as="h1" size="7">O que você quer construir em <span className="accent">{project.name}</span>?</Heading>
      <Card data-testid="project-state">
        <Text as="p" size="1" color="gray" className="mono">{project.path}</Text>
        <Text as="p">
          {!snapshot ? 'Lendo o estado do projeto…' : count === 0 ? 'Nenhum pedido ainda.' : `${count} pedido(s); o último é ${snapshot.selectedMission?.id}.`}
        </Text>
      </Card>
      <IntakeFlow key={project.id} projectId={project.id} />
      {snapshot?.selectedMission && <MissionUnits key={`${project.id}:${snapshot.selectedMission.id}`} projectId={project.id} missionId={snapshot.selectedMission.id} />}
    </Flex>
  )
}

function ProjectsPage({ projects, onOpen }: { projects: Project[]; onOpen: (dir: string) => void }) {
  const [dir, setDir] = useState('')
  const closed = projects.filter((p) => !p.open)

  function submit(e: FormEvent) {
    e.preventDefault()
    onOpen(dir.trim())
  }

  return (
    <Flex direction="column" gap="4">
      <Heading as="h1" size="7">Projetos</Heading>
      <Text color="gray">A ADE trabalha dentro de um repositório git do seu PC. Abrir outra pasta não interrompe a missão das que já estão abertas.</Text>
      <Card>
        <form className="dir-form" onSubmit={submit}>
          <TextField.Root
            className="grow"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder="E:\meus-projetos\minha-app"
            aria-label="Caminho da pasta"
          />
          <Button type="submit" disabled={!dir.trim()}>Abrir</Button>
        </form>
      </Card>
      {closed.length > 0 && (
        <Card>
          <Text as="p" weight="bold">Recentes</Text>
          <Flex direction="column" gap="2" mt="2">
            {closed.map((p) => (
              <Flex key={p.path} align="center" gap="2">
                <Box className="grow">
                  <Text as="p">{p.name}</Text>
                  <Text as="p" size="1" color="gray" className="mono">{p.path}</Text>
                </Box>
                <Badge color="gray">fechado</Badge>
                <Button variant="soft" aria-label={`Reabrir ${p.name}`} onClick={() => onOpen(p.path)}>Reabrir</Button>
              </Flex>
            ))}
          </Flex>
        </Card>
      )}
    </Flex>
  )
}
