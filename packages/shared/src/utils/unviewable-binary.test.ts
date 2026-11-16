import { describe, expect, test } from 'bun:test'
import {
  UNVIEWABLE_BINARY_HEAD_BYTES,
  UNVIEWABLE_BINARY_SUGGESTED_ACTION,
  describeUnviewableBinary,
  isUnviewableBinary,
  type UnviewableBinaryKind,
} from './unviewable-binary'

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text)

/** 生成 TAR 头部：ustar 魔数固定在偏移 257。 */
function tarHeadBytes(): Uint8Array {
  const bytes = new Uint8Array(UNVIEWABLE_BINARY_HEAD_BYTES)
  bytes.set(ascii('ustar'), 257)
  return bytes
}

describe('不可内联预览的二进制判定', () => {
  test('Given 常见容器/可执行扩展名 When 判定 Then 全部不可内联预览并给出系统打开建议', () => {
    const cases: Array<[string, UnviewableBinaryKind]> = [
      ['build/app.zip', 'archive'],
      ['demo.jar', 'archive'],
      ['app-release.apk', 'archive'],
      ['bundle.7z', 'archive'],
      ['archive.rar', 'archive'],
      ['source.tar', 'archive'],
      ['logs.tar.gz', 'archive'],
      ['installer.msi', 'archive'],
      ['tool.exe', 'executable'],
      ['native.dll', 'executable'],
      ['libdemo.so', 'executable'],
      ['libdemo.so.3', 'executable'],
      ['libdemo.dylib', 'executable'],
      ['module.wasm', 'executable'],
      ['cache.sqlite', 'database'],
      ['legacy.doc', 'document'],
      ['font.woff2', 'binary'],
    ]

    for (const [fileName, kind] of cases) {
      const info = describeUnviewableBinary(fileName)
      expect(info, fileName).not.toBeNull()
      expect(info?.kind, fileName).toBe(kind)
      expect(info?.suggestedAction, fileName).toBe(UNVIEWABLE_BINARY_SUGGESTED_ACTION)
      expect(isUnviewableBinary(fileName), fileName).toBe(true)
    }
  })

  test('Given 文本/PDF/图片/媒体扩展名 When 判定 Then 保持可预览', () => {
    const fileNames = [
      'report.pdf',
      'cover.png',
      'photo.JPEG',
      'animation.gif',
      'clip.mp4',
      'voice.mp3',
      'README.md',
      'script.ts',
      'data.json',
      'table.csv',
      'notes.txt',
    ]

    for (const fileName of fileNames) {
      expect(describeUnviewableBinary(fileName), fileName).toBeNull()
      expect(isUnviewableBinary(fileName), fileName).toBe(false)
    }
  })

  test('Given 改名的 ZIP/EXE/SQLite/WASM/ELF When 按魔数判定 Then 不受扩展名影响', () => {
    const cases: Array<[string, Uint8Array, string]> = [
      ['deliverable.txt', Uint8Array.of(0x50, 0x4b, 0x03, 0x04), 'zip'],
      ['deliverable.txt', Uint8Array.of(0x50, 0x4b, 0x05, 0x06), 'zip'],
      ['invoice.txt', Uint8Array.of(0x4d, 0x5a, 0x90, 0x00), 'pe'],
      ['payload.dat', Uint8Array.of(0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00), 'sqlite'],
      ['module.dat', Uint8Array.of(0x00, 0x61, 0x73, 0x6d), 'wasm'],
      ['library.dat', Uint8Array.of(0x7f, 0x45, 0x4c, 0x46), 'elf'],
      ['archive.dat', Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c), '7z'],
      ['archive.dat', Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07), 'rar'],
      ['stream.dat', Uint8Array.of(0x1f, 0x8b, 0x08), 'gzip'],
    ]

    for (const [fileName, headBytes, format] of cases) {
      const info = describeUnviewableBinary(fileName, headBytes)
      expect(info, `${fileName} ${format}`).not.toBeNull()
      expect(info?.format, `${fileName} ${format}`).toBe(format)
    }
  })

  test('Given TAR 的 ustar 魔数位于 257 偏移 When 判定 Then 识别为归档文件', () => {
    const info = describeUnviewableBinary('bundle.dat', tarHeadBytes())
    expect(info?.kind).toBe('archive')
    expect(info?.format).toBe('tar')
  })

  test('Given PDF/PNG 魔数但扩展名可疑 When 判定 Then 不拦截已有预览链路', () => {
    expect(describeUnviewableBinary('document.bin', ascii('%PDF-1.7'))).toBeNull()
    expect(describeUnviewableBinary('document.exe', ascii('%PDF-1.7'))).toBeNull()
    expect(describeUnviewableBinary('image.bin', Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBeNull()
  })

  test('Given Office Open XML 的 ZIP 魔数 When 判定 Then 保留文档预览链路', () => {
    const zipHead = Uint8Array.of(0x50, 0x4b, 0x03, 0x04)
    expect(describeUnviewableBinary('report.docx', zipHead)).toBeNull()
    expect(describeUnviewableBinary('data.xlsx', zipHead)).toBeNull()
    expect(describeUnviewableBinary('slides.pptx', zipHead)).toBeNull()
    // 普通 zip 与 jar/apk 仍然拦截。
    expect(describeUnviewableBinary('archive.zip', zipHead)?.kind).toBe('archive')
  })

  test('Given 普通文本或随机字节 When 判定 Then 不误判为不可预览二进制', () => {
    expect(describeUnviewableBinary('notes.txt', ascii('# 标题\n正文\n'))).toBeNull()
    expect(describeUnviewableBinary('notes.dat', Uint8Array.of(0x01, 0x02, 0x03, 0x04))).toBeNull()
    expect(isUnviewableBinary('notes.txt')).toBe(false)
  })

  test('Given 头部字节不足 When 判定 Then 安全退化到扩展名', () => {
    expect(describeUnviewableBinary('archive.zip', Uint8Array.of(0x50))?.kind).toBe('archive')
    expect(describeUnviewableBinary('notes.txt', Uint8Array.of(0x50))).toBeNull()
    // ustar 出现在偏移 0 而不是 257 时不能误判为 TAR。
    expect(describeUnviewableBinary('notes.txt', ascii('ustar'))).toBeNull()
    expect(describeUnviewableBinary('bundle.tar', Uint8Array.of(0x75, 0x73, 0x74, 0x61, 0x72))?.kind).toBe('archive')
  })

  test('Given Windows 风格路径或空路径 When 判定 Then 正确解析最后一段', () => {
    expect(isUnviewableBinary('C:\\Users\\demo\\build\\app.ZIP')).toBe(true)
    expect(isUnviewableBinary('/home/demo/report.pdf')).toBe(false)
    expect(isUnviewableBinary('')).toBe(false)
    expect(isUnviewableBinary('   ')).toBe(false)
  })

  test('Given 建议头部长度 When 读取 TAR 魔数 Then 常量足够覆盖偏移 257+5', () => {
    expect(UNVIEWABLE_BINARY_HEAD_BYTES).toBeGreaterThanOrEqual(262)
  })
})
