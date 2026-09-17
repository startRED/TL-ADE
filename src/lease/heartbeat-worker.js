import fs from 'node:fs'
import { workerData } from 'node:worker_threads'

const { heartbeatPath, heartbeatMs } = /** @type {{ heartbeatPath: string, heartbeatMs: number }} */ (
  workerData
)

/**
 * Escreve timestamp ISO no arquivo de heartbeat do lease.
 */
function beat() {
  try {
    fs.writeFileSync(heartbeatPath, new Date().toISOString())
  } catch {
    // lease já liberado
  }
}

setInterval(beat, heartbeatMs)
