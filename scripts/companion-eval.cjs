const { buildSync } = require('esbuild')
const { spawnSync } = require('node:child_process')
const checked = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'evals/companion_zh/tsconfig.json'], { stdio: 'inherit' })
if (checked.status !== 0) process.exit(checked.status ?? 1)
buildSync({ entryPoints: ['evals/companion_zh/index.ts'], outfile: '.generated/companion-eval.cjs',
  bundle: true, platform: 'node', format: 'cjs', packages: 'external' })
for (const args of [['--test', 'evals/companion_zh/tests/evaluator.test.cjs'], ['.generated/companion-eval.cjs']]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
