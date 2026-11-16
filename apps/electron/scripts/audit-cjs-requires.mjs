/**
 * CJS 产物的外部 require 审计。
 *
 * 主进程 / agent-runtime 产物是 esbuild 的 CJS 产物，静态 import 会被编译成 require()。
 * Pi SDK 是 ESM-only（package.json exports 只声明 import 条件），一旦源码里出现
 * 静态值导入，打包后启动即 ERR_PACKAGE_PATH_NOT_EXPORTED，开发期完全看不出来。
 *
 * 用法：node scripts/audit-cjs-requires.mjs dist/main.cjs dist/agent-runtime.cjs
 * 也被 scripts/cjs-esm-imports.test.ts 复用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules, createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const builtins = new Set(['electron', ...builtinModules])
// ws 的原生加速器自身带 try/catch，缺失时使用 JS 实现；不得泛化到必需依赖。
const optionalRequires = new Set(['bufferutil', 'utf-8-validate'])

/**
 * @param {string} bundlePath 相对或绝对的 bundle 路径
 * @returns {{ spec: string, status: 'ok' | 'optional' | 'fatal', detail: string }[]}
 */
export function auditBundle(bundlePath) {
  const abs = path.resolve(appDir, bundlePath)
  const req = createRequire(abs)
  const code = fs.readFileSync(abs, 'utf8')
  const findings = []
  for (const spec of collectExternalRequires(code)) {
    let resolved
    try {
      resolved = req.resolve(spec)
    } catch (error) {
      const optional = error.code === 'MODULE_NOT_FOUND' && optionalRequires.has(spec)
      findings.push({ spec, status: optional ? 'optional' : 'fatal', detail: error.code ?? String(error) })
      continue
    }
    const pkgPath = findPackageJson(resolved)
    const type = pkgPath ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')).type ?? 'commonjs' : 'commonjs'
    const loadsEsm = resolved.endsWith('.mjs') || (type === 'module' && resolved.endsWith('.js'))
    findings.push({
      spec,
      status: loadsEsm ? 'fatal' : 'ok',
      detail: loadsEsm ? `CJS require 指向 ESM 文件（依赖 require(esm)）: ${path.relative(appDir, resolved)}` : path.relative(appDir, resolved),
    })
  }
  return findings
}

function collectExternalRequires(code) {
  const specs = new Set()
  for (const match of code.matchAll(/\b(?:require|__require(?:\d+)?)\s*\(\s*(['"])([^'"\s]+)\1\s*\)/g)) {
    const spec = match[2]
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || builtins.has(spec)) continue
    // 拼接出来的说明符（如 `require('x' + name)`）无法静态解析，由 CJS 运行时自己负责。
    if (/\s/.test(spec) || /[+'"`]/.test(spec)) continue
    specs.add(spec)
  }
  return [...specs].sort()
}

function findPackageJson(from) {
  let dir = path.dirname(from)
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json')
    if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, 'utf8')).name) return candidate
    dir = path.dirname(dir)
  }
  return undefined
}

// 同时支持 Bun 与不提供 import.meta.main 的 Node/Electron 构建宿主。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 3) {
    console.error('用法：node audit-cjs-requires.mjs <bundle.cjs> [...]')
    process.exit(1)
  }
  let fatal = 0
  for (const bundle of process.argv.slice(2)) {
    const findings = auditBundle(bundle)
    console.log(`\n### ${path.basename(bundle)} — 外部 require ${findings.length} 个`)
    for (const finding of findings) {
      const mark = finding.status === 'ok' ? '[OK]  ' : finding.status === 'optional' ? '[跳过]' : '[FAIL]'
      console.log(`  ${mark} ${finding.spec} — ${finding.detail}`)
      if (finding.status === 'fatal') fatal++
    }
  }
  console.log(`\n结论：${fatal === 0 ? '没有阻塞性外部 require' : `${fatal} 个外部 require 存在加载风险`}`)
  process.exit(fatal === 0 ? 0 : 1)
}
