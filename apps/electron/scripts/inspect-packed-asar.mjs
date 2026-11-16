import asar from '@electron/asar'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const archive = path.join(appDir, 'out/win-unpacked/resources/app.asar')
const entries = asar.listPackage(archive).map((entry) => entry.replaceAll('\\', '/').replace(/^\//, ''))

console.log(`app.asar 条目总数: ${entries.length}`)
for (const wanted of [
  'dist/main.cjs',
  'dist/agent-runtime.cjs',
  'node_modules/@earendil-works/pi-ai/package.json',
  'node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js',
]) {
  console.log(entries.includes(wanted) ? `[在包内] ${wanted}` : `[缺失] ${wanted}`)
}

const code = asar.extractFile(archive, 'dist/main.cjs').toString('utf8')
const requires = [...code.matchAll(/require\(["'](@earendil-works[^"']*)["']\)/g)].map((m) => m[1])
const imports = [...new Set([...code.matchAll(/import\(["'](@earendil-works[^"']*)["']\)/g)].map((m) => m[1]))]
console.log(`包内 CJS require(pi-*): ${requires.length ? requires.join(', ') : '(无)'}`)
console.log(`包内 动态 import(pi-*): ${imports.join(', ')}`)
