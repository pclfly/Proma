/**
 * 官方 bundle 差量分析工具。
 *
 * 用途：把两个 esbuild 产物（本地构建 vs 官方安装包）按源文件注释、具名函数、
 * IPC 通道三个维度对比，生成“官方新增 / 双方不同 / 本地独有”清单，供逐项移植。
 *
 * 用法：
 *   bun apps/electron/scripts/upstream-delta.cjs <本地-main.cjs> <官方-main.cjs>
 *   bun apps/electron/scripts/upstream-delta.cjs <本地> <官方> --json
 *
 * 说明：官方 bundle 未 minify，保留 `// src/...` 源文件注释和函数名；renderer 不在
 * 本工具的覆盖范围内。
 */
const fs = require('node:fs')

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n')
}

/**
 * 按 esbuild 的源文件注释切分：
 * - 主进程：`// src/...`
 * - workspace 共享包：`// ../../packages/...`
 */
function parseSections(lines) {
  const marks = []
  for (let i = 0; i < lines.length; i++) {
    const match = /^\/\/ ((?:src\/|(?:\.\.\/)+packages\/)[^\s]+)$/.exec(lines[i])
    if (match) marks.push([match[1], i])
  }
  const sections = new Map()
  for (let i = 0; i < marks.length; i++) {
    const [file, start] = marks[i]
    const end = i + 1 < marks.length ? marks[i + 1][1] : lines.length
    sections.set(file, {
      body: lines.slice(start, end).join('\n'),
      lines: end - start,
    })
  }
  return sections
}

/** 提取顶层具名函数（esbuild 产物中函数声明从行首开始）。 */
function parseFunctions(lines) {
  const functions = new Map()
  for (let i = 0; i < lines.length; i++) {
    const match = /^(?:async )?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i])
    if (!match) continue
    let end = i + 1
    while (end < lines.length && lines[end] !== '}') end++
    if (end >= lines.length) continue
    functions.set(match[1], {
      body: lines.slice(i, end + 1).join('\n'),
      line: i + 1,
    })
  }
  return functions
}

/** 提取主进程注册的 IPC 通道。 */
function parseIpc(lines) {
  const channels = new Set()
  const pattern = /ipcMain\.(?:handle|handleOnce|on)\("([^"]+)"/g
  for (const line of lines) {
    let match
    while ((match = pattern.exec(line)) !== null) channels.add(match[1])
  }
  return channels
}

const normalize = (text) => text.replace(/\s+/g, ' ').trim()

function diffSections(local, official) {
  const onlyOfficial = []
  const onlyLocal = []
  const changed = []
  for (const [file, section] of official) {
    const localSection = local.get(file)
    if (!localSection) onlyOfficial.push({ file, lines: section.lines })
    else if (normalize(localSection.body) !== normalize(section.body)) {
      changed.push({ file, localLines: localSection.lines, officialLines: section.lines })
    }
  }
  for (const [file, section] of local) {
    if (!official.has(file)) onlyLocal.push({ file, lines: section.lines })
  }
  const byLines = (a, b) => b.lines - a.lines
  const byOfficialLines = (a, b) => b.officialLines - a.officialLines
  return {
    onlyOfficial: onlyOfficial.sort(byLines),
    onlyLocal: onlyLocal.sort(byLines),
    changed: changed.sort(byOfficialLines),
  }
}

function diffFunctions(local, official) {
  const onlyOfficial = []
  const onlyLocal = []
  const changed = []
  for (const [name, fn] of official) {
    const localFn = local.get(name)
    if (!localFn) onlyOfficial.push(name)
    else if (normalize(localFn.body) !== normalize(fn.body)) changed.push(name)
  }
  for (const name of local.keys()) {
    if (!official.has(name)) onlyLocal.push(name)
  }
  return {
    onlyOfficial: onlyOfficial.sort(),
    onlyLocal: onlyLocal.sort(),
    changed: changed.sort(),
  }
}

function diffSets(local, official) {
  return {
    onlyOfficial: [...official].filter((item) => !local.has(item)).sort(),
    onlyLocal: [...local].filter((item) => !official.has(item)).sort(),
  }
}

function main() {
  const args = process.argv.slice(2)
  const jsonMode = args.includes('--json')
  const [localPath, officialPath] = args.filter((arg) => arg !== '--json')
  if (!localPath || !officialPath) {
    console.error('用法: bun apps/electron/scripts/upstream-delta.cjs <本地-main.cjs> <官方-main.cjs> [--json]')
    process.exit(1)
  }

  const localLines = readLines(localPath)
  const officialLines = readLines(officialPath)
  const localSections = parseSections(localLines)
  const officialSections = parseSections(officialLines)
  const localFunctions = parseFunctions(localLines)
  const officialFunctions = parseFunctions(officialLines)
  const localIpc = parseIpc(localLines)
  const officialIpc = parseIpc(officialLines)

  const report = {
    summary: {
      localSections: localSections.size,
      officialSections: officialSections.size,
      localFunctions: localFunctions.size,
      officialFunctions: officialFunctions.size,
      localIpc: localIpc.size,
      officialIpc: officialIpc.size,
    },
    sections: diffSections(localSections, officialSections),
    functions: diffFunctions(localFunctions, officialFunctions),
    ipc: diffSets(localIpc, officialIpc),
  }

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  const { summary, sections, functions, ipc } = report
  console.log('== 概览 ==')
  console.log(`源文件段: 本地 ${summary.localSections} / 官方 ${summary.officialSections}`)
  console.log(`具名函数: 本地 ${summary.localFunctions} / 官方 ${summary.officialFunctions}`)
  console.log(`IPC 通道: 本地 ${summary.localIpc} / 官方 ${summary.officialIpc}`)

  console.log('\n== 官方独有源文件段（行数降序） ==')
  for (const item of sections.onlyOfficial) console.log(`${String(item.lines).padStart(7)}  ${item.file}`)

  console.log('\n== 双方都有但内容不同（官方行数降序） ==')
  for (const item of sections.changed) {
    console.log(`${String(item.localLines).padStart(7)} -> ${String(item.officialLines).padStart(7)}  ${item.file}`)
  }

  console.log('\n== 本地独有源文件段 ==')
  for (const item of sections.onlyLocal) console.log(`${String(item.lines).padStart(7)}  ${item.file}`)

  console.log('\n== 官方独有函数 ==')
  for (const name of functions.onlyOfficial) console.log(name)

  console.log('\n== 双方都有但实现不同的函数 ==')
  for (const name of functions.changed) console.log(name)

  console.log('\n== 本地独有函数 ==')
  for (const name of functions.onlyLocal) console.log(name)

  console.log('\n== 官方独有 IPC 通道 ==')
  for (const channel of ipc.onlyOfficial) console.log(channel)

  console.log('\n== 本地独有 IPC 通道 ==')
  for (const channel of ipc.onlyLocal) console.log(channel)
}

main()
