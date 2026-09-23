#!/usr/bin/env node
import { main } from '../src/cli/index.ts'

main(process.argv.slice(2)).then((c) => {
  process.exitCode = c
})
