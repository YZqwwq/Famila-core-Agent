const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const source = path.join(root, 'src/main/services/aiservice/testarea/tests')
const generated = path.join(root, '.generated')
fs.mkdirSync(generated, { recursive: true })
const files = fs.readdirSync(source).filter(name => name.endsWith('.test.ts'))
for (const file of files) {
  esbuild.buildSync({
    entryPoints: [path.join(source, file)],
    outfile: path.join(generated, file.replace('.ts', '.cjs')),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    alias: { '@share': path.join(root, 'src/share') },
    tsconfig: path.join(root, 'tsconfig.json'),
    logLevel: 'warning'
  })
}
const result = spawnSync(process.execPath, ['--test', ...files.map(file => path.join(generated, file.replace('.ts', '.cjs')))], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, RUN_TURN_VERSION_SQLITE_TESTS: '1', FAMILA_TEST_SQLJS: process.env.FAMILA_TEST_SQLJS ?? '1', WORLDEDIT_AGENT_TRACE_ROOT: path.join(generated, 'traces') }
})
process.exit(result.status ?? 1)
