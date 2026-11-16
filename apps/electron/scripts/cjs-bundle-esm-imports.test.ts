import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { auditBundle } from './audit-cjs-requires.mjs'

const appDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const srcDir = path.join(appDir, 'src')

// 主进程 / agent-runtime 是 esbuild 的 CJS 产物：静态 import 会变成 require()。
// Pi SDK 只声明 import 条件，静态值导入一旦进入产物，打包后启动即崩。
const STATIC_PI_IMPORT = /^import\b(?:(?!^import\b)[\s\S])*?from\s+['"](@earendil-works\/[^'"]+)['"]/gm

function productionSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) return productionSources(abs)
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return []
    return [abs]
  })
}

function staticRuntimeImports(file: string): { specifier: string; line: number }[] {
  const found: { specifier: string; line: number }[] = []
  for (const match of fs.readFileSync(file, 'utf8').matchAll(STATIC_PI_IMPORT)) {
    const statement = match[0]
    // import type / export type 在编译期被擦除，不产生 require。
    if (/^import\s+type\b/.test(statement.trimStart())) continue
    found.push({ specifier: match[1], line: file.slice(0, match.index).split('\n').length })
  }
  return found
}

describe('CJS 产物与 ESM-only 的 pi-* 依赖', () => {
  test('Given 必需依赖缺失和明确可选依赖 When 审计 Then 只有可选依赖可跳过', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'proma-cjs-audit-'))
    try {
      const bundle = path.join(dir, 'fixture.cjs')
      fs.writeFileSync(bundle, `require("proma-required-missing-fixture"); require('bufferutil'); require("node:fs");`)
      expect(auditBundle(bundle).map(({ spec, status }) => ({ spec, status }))).toEqual([
        { spec: 'bufferutil', status: 'optional' },
        { spec: 'proma-required-missing-fixture', status: 'fatal' },
      ])
      const cli = spawnSync('node', [path.join(appDir, 'scripts/audit-cjs-requires.mjs'), bundle], { encoding: 'utf8' })
      expect(cli.status).toBe(1)
      expect(cli.stdout).toContain('proma-required-missing-fixture')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  test('Given import-only及ESM包 When CJS产物引用 Then 构建审计拒绝', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'proma-cjs-esm-'))
    try {
      for (const name of ['esm-fixture', 'import-only-fixture']) {
        const pkg = path.join(dir, 'node_modules', name)
        fs.mkdirSync(pkg, { recursive: true })
        fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, type: 'module', exports: name === 'esm-fixture' ? './index.js' : { import: './index.js' } }))
        fs.writeFileSync(path.join(pkg, 'index.js'), 'export const value = 1')
      }
      const bundle = path.join(dir, 'fixture.cjs')
      fs.writeFileSync(bundle, `__require("esm-fixture"); __require2("import-only-fixture");`)
      expect(auditBundle(bundle).map(({ status }) => status)).toEqual(['fatal', 'fatal'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  test('Given 常规和快速打包入口 When 构建 Then 均经过运行时构建与审计', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(scripts.build).toContain('bun run build:runtime')
    expect(scripts['build:runtime']).toContain('build:agent-runtime')
    expect(scripts['build:runtime']).toContain('audit:cjs-requires')
    expect(fs.readFileSync(path.join(appDir, 'scripts/dist.ts'), 'utf8')).toContain("['run', 'build:runtime']")
  })

  test('Given 主进程源码 When 静态导入 pi-* 运行时值 Then esbuild 会产出启动即崩的 require', () => {
    const offenders = productionSources(srcDir).flatMap((file) =>
      staticRuntimeImports(file).map((hit) => `${path.relative(appDir, file)}:${hit.line} → ${hit.specifier}`))
    expect(offenders).toEqual([])
  })

  test('Given 已构建的 CJS 产物 When 解析每个外部 require Then 必须能被 CJS 直接加载', () => {
    const fatal = ['dist/main.cjs', 'dist/agent-runtime.cjs']
      .filter((bundle) => fs.existsSync(path.join(appDir, bundle)))
      .flatMap((bundle) => auditBundle(bundle)
        .filter((finding) => finding.status === 'fatal')
        .map((finding) => `${bundle}: ${finding.spec} — ${finding.detail}`))
    expect(fatal).toEqual([])
  })
})
