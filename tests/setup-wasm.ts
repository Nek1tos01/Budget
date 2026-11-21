import { readFile } from 'node:fs/promises'
import { initializeBudgetEngine } from '../src/domain/engine'

await initializeBudgetEngine(await readFile(new URL('../src/domain/budget-core.wasm', import.meta.url)))
