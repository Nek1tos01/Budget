import { spawn, execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const tempRoot = resolve(tmpdir())
const prefix = 'budget-pages-e2e-'
const state = resolve(await mkdtemp(join(tempRoot, prefix)))
function cleanState() {
  if (dirname(state) !== tempRoot || !basename(state).startsWith(prefix)) throw new Error('Unexpected D1 test directory')
  return rm(state, { force: true, recursive: true, maxRetries: 5 })
}
const cli = join('node_modules', 'wrangler', 'bin', 'wrangler.js')
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' }
const port = process.env.BUDGET_CLOUD_TEST_PORT ?? '4191'
try {
  await promisify(execFile)(process.execPath, [cli, 'd1', 'migrations', 'apply', 'budget', '--local', '--persist-to', state], { env, windowsHide: true })
} catch (error) {
  await cleanState()
  throw error
}
const server = spawn(process.execPath, [
  cli, 'pages', 'dev', 'dist', '--ip', '127.0.0.1', '--port', port, '--persist-to', state,
], { env, stdio: 'inherit', windowsHide: true })
process.once('SIGINT', () => server.kill())
process.once('SIGTERM', () => server.kill())
server.once('exit', code => {
  process.exitCode = code ?? 0
  void cleanState().catch(() => { process.exitCode ||= 1 })
})
