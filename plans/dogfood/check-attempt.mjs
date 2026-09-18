import { validate } from '../../src/schema/index.js'

const base = {
  format_version: 1,
  seq: 1,
  at: '2026-09-18T00:00:00.000Z',
  prev: null,
  kind: 'telemetry',
  effect_class: 'none',
  input_digest: '0123456789abcdef',
  intent_context: {},
  worktree: '.',
  receipt_path: '',
  session_ref: null,
  runtime_stamp: '1:ab:cd',
}

let numPassedTests = 0
let numFailedTests = 0

// Checagem 1: {...base, attempt: 2} válido
if (validate('journal-event', { ...base, attempt: 2 }).valid) {
  numPassedTests++
} else {
  numFailedTests++
}

// Checagem 2: {...base, attempt: 0} inválido
if (!validate('journal-event', { ...base, attempt: 0 }).valid) {
  numPassedTests++
} else {
  numFailedTests++
}

// Checagem 3: base válido
if (validate('journal-event', base).valid) {
  numPassedTests++
} else {
  numFailedTests++
}

const summary = {
  numTotalTests: 3,
  numPassedTests,
  numFailedTests,
}

process.stdout.write(JSON.stringify(summary) + '\n')
process.exit(numPassedTests === 3 ? 0 : 1)
