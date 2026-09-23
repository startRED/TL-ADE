import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { AdeError } from '../journal/errors.ts'
import { projectMissionFromSources } from './projection.js'
import { listProjects } from './projects.js'

const require = createRequire(import.meta.url)

/**
 * Verifica se a dependência nativa better-sqlite3 está instalada e funcional.
 * Falha alto e explicativo caso esteja indisponível.
 *
 * @returns {any} A classe de Database do better-sqlite3
 */
export function checkNativeSqlite() {
  try {
    // Dynamic import ou require do better-sqlite3
    const moduleName = 'better-sqlite3'
    const Database = require(moduleName)
    // Testa instanciação em memória para confirmar compilação nativa válida
    const probeDb = new Database(':memory:')
    probeDb.exec('CREATE TABLE _probe (id INT);')
    probeDb.close()
    return Database
  } catch (err) {
    throw new AdeError(
      'native_sqlite_unavailable',
      `Dependência nativa better-sqlite3 indisponível ou incompatível neste ambiente Windows. Para corrigir, execute: npm rebuild better-sqlite3 ou instale as ferramentas de compilação C++ (Visual Studio Build Tools). Detalhe: ${err instanceof Error ? err.message : String(err)}`,
      1,
      { cause: err },
    )
  }
}

/**
 * Reconstrói atomicamente o índice SQLite (.ade/index.sqlite) a partir das fontes duráveis.
 *
 * @param {{ repoDir?: string, indexPath?: string }} [options]
 * @returns {Promise<{ missions: number, events: number, digest: string }>}
 */
export async function rebuildProjection({ repoDir = process.cwd(), indexPath } = {}) {
  const Database = checkNativeSqlite()

  const resolvedRepo = path.resolve(repoDir)
  const finalIndexPath = indexPath ? path.resolve(indexPath) : path.join(resolvedRepo, '.ade', 'index.sqlite')
  const adeDir = path.dirname(finalIndexPath)
  fs.mkdirSync(adeDir, { recursive: true })

  const missionsDir = path.join(resolvedRepo, '.ade', 'missions')
  const projectedMissions = []

  // 1. Validar todas as fontes antes de tocar no índice de destino
  if (fs.existsSync(missionsDir)) {
    const entries = fs.readdirSync(missionsDir).sort()
    for (const entry of entries) {
      const missionPath = path.join(missionsDir, entry)
      if (fs.statSync(missionPath).isDirectory() && fs.existsSync(path.join(missionPath, 'plan.json'))) {
        const projected = projectMissionFromSources({ missionDir: missionPath })
        projectedMissions.push(projected)
      }
    }
  }

  // 2. Criar em arquivo temporário único
  const tmpPath = `${finalIndexPath}.tmp.${process.pid}.${Date.now()}`

  try {
    const db = new Database(tmpPath)

    // Esquema estritamente determinístico
    db.exec(`
      PRAGMA synchronous = OFF;
      PRAGMA journal_mode = MEMORY;

      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        digest TEXT,
        immutable_digest TEXT,
        title TEXT,
        intent TEXT,
        autonomy TEXT,
        max_usd REAL,
        consumed_usd REAL,
        total_calls INTEGER,
        data_json TEXT
      );

      CREATE TABLE epics (
        mission_id TEXT,
        id TEXT,
        title TEXT,
        stories_json TEXT,
        PRIMARY KEY (mission_id, id)
      );

      CREATE TABLE stories (
        mission_id TEXT,
        id TEXT,
        title TEXT,
        task TEXT,
        complexity TEXT,
        needs_ui INTEGER,
        status TEXT,
        reason TEXT,
        calls INTEGER,
        cost REAL,
        data_json TEXT,
        PRIMARY KEY (mission_id, id)
      );

      CREATE TABLE events (
        mission_id TEXT,
        seq INTEGER,
        at TEXT,
        kind TEXT,
        effect_class TEXT,
        unit TEXT,
        data_json TEXT,
        PRIMARY KEY (mission_id, seq)
      );

      CREATE TABLE decisions (
        mission_id TEXT,
        seq INTEGER,
        at TEXT,
        decision TEXT,
        source TEXT,
        data_json TEXT,
        PRIMARY KEY (mission_id, seq)
      );

      CREATE TABLE artifacts (
        mission_id TEXT,
        ref TEXT,
        name TEXT,
        size INTEGER,
        PRIMARY KEY (mission_id, ref)
      );
    `)

    const insertMission = db.prepare(`
      INSERT INTO missions (id, digest, immutable_digest, title, intent, autonomy, max_usd, consumed_usd, total_calls, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertEpic = db.prepare(`
      INSERT INTO epics (mission_id, id, title, stories_json)
      VALUES (?, ?, ?, ?)
    `)

    const insertStory = db.prepare(`
      INSERT INTO stories (mission_id, id, title, task, complexity, needs_ui, status, reason, calls, cost, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertEvent = db.prepare(`
      INSERT INTO events (mission_id, seq, at, kind, effect_class, unit, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    const insertDecision = db.prepare(`
      INSERT INTO decisions (mission_id, seq, at, decision, source, data_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    const insertArtifact = db.prepare(`
      INSERT INTO artifacts (mission_id, ref, name, size)
      VALUES (?, ?, ?, ?)
    `)

    let totalEvents = 0

    // Ordenação determinística de inserção
    for (const m of projectedMissions) {
      insertMission.run(
        m.id,
        m.digest,
        m.immutable_digest,
        m.title,
        m.intent,
        m.autonomy,
        m.max_usd,
        m.consumed_usd,
        m.total_calls,
        JSON.stringify(m),
      )

      for (const e of m.epics) {
        insertEpic.run(m.id, e.id, e.title, JSON.stringify(e.stories))
      }

      for (const s of m.stories) {
        insertStory.run(
          m.id,
          s.id,
          s.title,
          s.task,
          s.complexity,
          s.needs_ui ? 1 : 0,
          s.status,
          s.reason,
          s.calls,
          s.cost,
          JSON.stringify(s),
        )
      }

      for (const ev of m.events) {
        totalEvents++
        insertEvent.run(
          m.id,
          ev.seq,
          ev.at,
          ev.kind,
          ev.effect_class,
          ev.unit || null,
          JSON.stringify(ev),
        )
      }

      for (const dec of m.decisions) {
        insertDecision.run(
          m.id,
          dec.seq,
          dec.at,
          dec.decision,
          dec.source,
          JSON.stringify(dec.data || {}),
        )
      }

      for (const art of m.artifacts) {
        insertArtifact.run(m.id, art.ref, art.name, art.size)
      }
    }

    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('version', '0.4b')
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('built_at', 'deterministic')

    db.close()

    // 3. Substituição atômica via rename
    fs.renameSync(tmpPath, finalIndexPath)

    const fileBuffer = fs.readFileSync(finalIndexPath)
    const digest = createHash('sha256').update(fileBuffer).digest('hex')

    return {
      missions: projectedMissions.length,
      events: totalEvents,
      digest,
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
    } catch {}
    throw err
  }
}

/**
 * Lê o snapshot projetado para o painel a partir do índice SQLite.
 *
 * @param {{ repoDir?: string, indexPath?: string }} [options]
 * @returns {Promise<{ projects: any[], missions: any[], selectedMission: any }>}
 */
export async function readPanelSnapshot({ repoDir = process.cwd(), indexPath } = {}) {
  const Database = checkNativeSqlite()
  const resolvedRepo = path.resolve(repoDir)
  const finalIndexPath = indexPath ? path.resolve(indexPath) : path.join(resolvedRepo, '.ade', 'index.sqlite')

  if (!fs.existsSync(finalIndexPath)) {
    await rebuildProjection({ repoDir: resolvedRepo, indexPath: finalIndexPath })
  }

  const db = new Database(finalIndexPath, { readonly: true })
  try {
    const rawMissions = db.prepare('SELECT data_json FROM missions ORDER BY id DESC').all()
    const missions = rawMissions.map((/** @type {any} */ row) => JSON.parse(row.data_json))

    const projects = listProjects({ repoDir: resolvedRepo })
    const selectedMission = missions[0] || null

    return {
      projects,
      missions,
      selectedMission,
    }
  } finally {
    db.close()
  }
}
