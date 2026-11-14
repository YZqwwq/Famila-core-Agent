const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../src')
const errors = []
let count = 0
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) { scan(file); continue }
    if (!file.endsWith('.ts')) continue
    count++
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)) {
      const spec = match[1]
      if (/^(electron|vue)(\/|$)/.test(spec) || spec.includes('worldEdit-agent') || /services\/worldbuilding/.test(spec) || spec.includes('child-agent-system')) {
        errors.push(`${file}: forbidden host dependency ${spec}`)
      }
      if (!spec.startsWith('.') && !spec.startsWith('@share/')) continue
      const target = spec.startsWith('@share/') ? path.join(root, 'share', spec.slice(7)) : path.resolve(path.dirname(file), spec)
      if (![target, target + '.ts', path.join(target, 'index.ts')].some(p => fs.existsSync(p))) errors.push(`${file}: unresolved ${spec}`)
      if (path.relative(root, target).startsWith('..')) errors.push(`${file}: dependency escapes package ${spec}`)
    }
  }
}
scan(root)
if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
console.log(`Boundary check passed (${count} TypeScript files).`)
