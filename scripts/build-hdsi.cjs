const path = require('node:path')
require('esbuild').buildSync({
  entryPoints: [path.resolve(__dirname, '../vendor/hdsi/entry.ts')],
  outfile: path.resolve(__dirname, '../dist/hdsi/upstream.cjs'),
  bundle: true, platform: 'node', format: 'cjs', packages: 'external',
  tsconfigRaw: { compilerOptions: { target: 'ES2022', experimentalDecorators: true } }
})
