import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const exports = [
  'malloc', 'free', 'budget_add', 'budget_round_up_to_ruble', 'budget_period', 'budget_includes',
  'budget_usage_percent', 'budget_percent_change', 'budget_summary', 'budget_breakdown', 'budget_forecast',
]
const sources = ['money', 'calendar', 'engine', 'wasm'].map(name => `cpp/budget-core/src/${name}.cpp`)
const args = [
  '-std=c++20', '-Os', '-Wall', '-Wextra', '-Werror', '-fno-exceptions', '-fno-rtti',
  '-Icpp/budget-core/include', ...sources,
  '--no-entry', '-sSTANDALONE_WASM=1', '-sWASM_BIGINT=1',
  '-sALLOW_MEMORY_GROWTH=1', '-sABORTING_MALLOC=0',
  `-sEXPORTED_FUNCTIONS=${exports.map(name => '_' + name).join(',')}`,
  '-o', 'src/domain/budget-core.wasm',
]
const options = { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit' }
const result = process.platform === 'win32'
  ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'em++ ' + args.join(' ')], options)
  : spawnSync('em++', args, options)

if (result.error) {
  process.stderr.write(`Запустите сборку в активном окружении Emscripten SDK. ${result.error.message}\n`)
}
process.exitCode = result.status ?? 1
