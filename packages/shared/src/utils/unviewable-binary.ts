/**
 * 不可内联预览的二进制文件判定。
 *
 * 官方 0.22.28：容器类二进制（zip/jar/apk/7z 等）不再尝试内联预览，改为交给系统应用打开。
 * 本模块是纯函数，不依赖任何 Node API，渲染进程与主进程可以共用：
 * 调用方按需读取文件头若干字节（`UNVIEWABLE_BINARY_HEAD_BYTES`）传入即可，
 * 不传头部时只按扩展名判定。
 *
 * 判定顺序：魔数（更强证据）→ 扩展名。PDF 与常见图片有独立的预览链路，
 * 即使换名或扩展名缺失也保持「可预览」，不在这里拦截。
 */

export type UnviewableBinaryKind =
  | 'archive'
  | 'executable'
  | 'database'
  | 'document'
  | 'binary'

export interface UnviewableBinaryInfo {
  /** 文件分类 */
  kind: UnviewableBinaryKind
  /** 命中依据对应的格式标识，例如 zip、7z、pe、sqlite 或扩展名本身 */
  format: string
  /** 面向用户的中文类型标签 */
  label: string
  /** 建议动作：不要内联预览，交给系统应用打开 */
  suggestedAction: string
}

/** 建议调用方读取并传入的头部字节数（TAR 的 ustar 魔数位于偏移 257）。 */
export const UNVIEWABLE_BINARY_HEAD_BYTES = 512

/** 二进制文件不可内联预览时的统一建议动作。 */
export const UNVIEWABLE_BINARY_SUGGESTED_ACTION = '使用系统应用打开'

interface BinaryMagic {
  bytes: readonly number[]
  offset?: number
  kind: UnviewableBinaryKind
  format: string
  label: string
}

interface ExtensionInfo {
  kind: UnviewableBinaryKind
  format: string
  label: string
}

const ZIP_MAGIC: readonly number[] = [0x50, 0x4b, 0x03, 0x04]
const EMPTY_ZIP_MAGIC: readonly number[] = [0x50, 0x4b, 0x05, 0x06]
const SPANNED_ZIP_MAGIC: readonly number[] = [0x50, 0x4b, 0x07, 0x08]

const UNVIEWABLE_MAGICS: readonly BinaryMagic[] = [
  { bytes: ZIP_MAGIC, kind: 'archive', format: 'zip', label: 'ZIP 压缩包或容器（jar/apk/docx 等）' },
  { bytes: EMPTY_ZIP_MAGIC, kind: 'archive', format: 'zip', label: 'ZIP 压缩包或容器（jar/apk/docx 等）' },
  { bytes: SPANNED_ZIP_MAGIC, kind: 'archive', format: 'zip', label: 'ZIP 压缩包或容器（jar/apk/docx 等）' },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], kind: 'archive', format: '7z', label: '7-Zip 压缩包' },
  { bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], kind: 'archive', format: 'rar', label: 'RAR 压缩包' },
  { bytes: [0x1f, 0x8b], kind: 'archive', format: 'gzip', label: 'GZIP 压缩文件' },
  { bytes: [0x42, 0x5a, 0x68], kind: 'archive', format: 'bzip2', label: 'BZIP2 压缩文件' },
  { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], kind: 'archive', format: 'xz', label: 'XZ 压缩文件' },
  { bytes: [0x28, 0xb5, 0x2f, 0xfd], kind: 'archive', format: 'zstd', label: 'Zstandard 压缩文件' },
  { bytes: [0x75, 0x73, 0x74, 0x61, 0x72], offset: 257, kind: 'archive', format: 'tar', label: 'TAR 归档文件' },
  { bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00], kind: 'database', format: 'sqlite', label: 'SQLite 数据库' },
  { bytes: [0x00, 0x61, 0x73, 0x6d], kind: 'executable', format: 'wasm', label: 'WebAssembly 模块' },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], kind: 'executable', format: 'elf', label: 'ELF 可执行文件或动态库' },
  { bytes: [0x4d, 0x5a], kind: 'executable', format: 'pe', label: 'Windows 可执行文件或 DLL' },
  { bytes: [0xfe, 0xed, 0xfa, 0xce], kind: 'executable', format: 'macho', label: 'Mach-O 可执行文件或动态库' },
  { bytes: [0xce, 0xfa, 0xed, 0xfe], kind: 'executable', format: 'macho', label: 'Mach-O 可执行文件或动态库' },
  { bytes: [0xfe, 0xed, 0xfa, 0xcf], kind: 'executable', format: 'macho', label: 'Mach-O 可执行文件或动态库' },
  { bytes: [0xcf, 0xfa, 0xed, 0xfe], kind: 'executable', format: 'macho', label: 'Mach-O 可执行文件或动态库' },
  { bytes: [0xca, 0xfe, 0xba, 0xbe], kind: 'executable', format: 'macho-fat', label: 'Mach-O 通用二进制或 Java 字节码' },
  { bytes: [0xbe, 0xba, 0xfe, 0xca], kind: 'executable', format: 'macho-fat', label: 'Mach-O 通用二进制或 Java 字节码' },
]

/** PDF 与图片有独立预览链路，命中这些魔数时不拦截。 */
const VIEWABLE_MAGICS: readonly BinaryMagic[] = [
  { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], kind: 'binary', format: 'pdf', label: 'PDF 文档' },
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], kind: 'binary', format: 'png', label: 'PNG 图片' },
  { bytes: [0xff, 0xd8, 0xff], kind: 'binary', format: 'jpeg', label: 'JPEG 图片' },
  { bytes: [0x47, 0x49, 0x46, 0x38], kind: 'binary', format: 'gif', label: 'GIF 图片' },
  { bytes: [0x42, 0x4d], kind: 'binary', format: 'bmp', label: 'BMP 图片' },
  { bytes: [0x49, 0x49, 0x2a, 0x00], kind: 'binary', format: 'tiff', label: 'TIFF 图片' },
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], kind: 'binary', format: 'tiff', label: 'TIFF 图片' },
]

const ARCHIVE_EXTENSIONS = new Set([
  'zip', 'jar', 'apk', 'aab', 'war', 'ear', 'whl', 'egg', 'nupkg', 'vsix',
  '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', 'zst', 'zstd',
  'lz4', 'lzma', 'cab', 'iso', 'dmg', 'deb', 'rpm', 'pkg', 'mpkg', 'msi', 'msix',
  'appx', 'appxbundle',
])

const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'dll', 'so', 'dylib', 'sys', 'ocx', 'cpl', 'drv', 'efi', 'elf',
  'bin', 'o', 'obj', 'a', 'lib', 'out', 'class', 'pyc', 'pyo', 'node', 'wasm',
])

const DATABASE_EXTENSIONS = new Set([
  'sqlite', 'sqlite3', 's3db', 'db', 'db3', 'mdb', 'accdb', 'realm', 'duckdb',
])

const DOCUMENT_EXTENSIONS = new Set([
  'doc', 'dot', 'xls', 'xlt', 'ppt', 'pot', 'vsd', 'pub', 'msg',
])

const BINARY_EXTENSIONS = new Set([
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'psd', 'ai', 'sketch', 'fig', 'xd',
  'pkl', 'pickle', 'npy', 'parquet', 'avro', 'orc', 'arrow', 'feather',
])

/** Office Open XML 是 ZIP 容器，但 file-preview-service 有独立的文档预览链路。 */
const OFFICE_OPEN_XML_EXTENSIONS = new Set([
  'docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm',
])

const EXTENSION_LABELS: Record<UnviewableBinaryKind, string> = {
  archive: '压缩包或容器文件',
  executable: '可执行文件或程序集',
  database: '数据库文件',
  document: '二进制文档',
  binary: '二进制文件',
}

function matchesMagic(headBytes: Uint8Array, magic: BinaryMagic): boolean {
  const offset = magic.offset ?? 0
  if (headBytes.length < offset + magic.bytes.length) return false
  for (let index = 0; index < magic.bytes.length; index += 1) {
    if (headBytes[offset + index] !== magic.bytes[index]) return false
  }
  return true
}

function toInfo(magic: BinaryMagic): UnviewableBinaryInfo {
  return {
    kind: magic.kind,
    format: magic.format,
    label: magic.label,
    suggestedAction: UNVIEWABLE_BINARY_SUGGESTED_ACTION,
  }
}

/** 取最后一个路径分隔段，兼容 Windows 与 POSIX 风格路径。 */
function getBaseName(fileName: string): string {
  const segments = fileName.trim().split(/[\\/]/)
  return segments[segments.length - 1] ?? ''
}

function getExtension(fileName: string): string {
  const baseName = getBaseName(fileName)
  const dotIndex = baseName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) return ''
  return baseName.slice(dotIndex + 1).toLowerCase()
}

function hasVersionedLibrarySuffix(baseName: string): boolean {
  return /\.(?:so|dylib)(?:\.\d+)+$/i.test(baseName)
}

function getExtensionInfo(fileName: string): ExtensionInfo | null {
  const baseName = getBaseName(fileName)
  if (hasVersionedLibrarySuffix(baseName)) {
    return { kind: 'executable', format: 'so', label: EXTENSION_LABELS.executable }
  }

  const extension = getExtension(fileName)
  if (extension === '') return null
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return { kind: 'archive', format: extension, label: EXTENSION_LABELS.archive }
  }
  if (EXECUTABLE_EXTENSIONS.has(extension)) {
    return { kind: 'executable', format: extension, label: EXTENSION_LABELS.executable }
  }
  if (DATABASE_EXTENSIONS.has(extension)) {
    return { kind: 'database', format: extension, label: EXTENSION_LABELS.database }
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return { kind: 'document', format: extension, label: EXTENSION_LABELS.document }
  }
  if (BINARY_EXTENSIONS.has(extension)) {
    return { kind: 'binary', format: extension, label: EXTENSION_LABELS.binary }
  }
  return null
}

function isOfficeOpenXml(fileName: string): boolean {
  return OFFICE_OPEN_XML_EXTENSIONS.has(getExtension(fileName))
}

/**
 * 判断文件是否为不应内联预览的二进制类型。
 *
 * @param fileName 文件名或完整路径（只读取最后一段的扩展名）
 * @param headBytes 可选的文件头字节；命中魔数时优先于扩展名判定
 */
export function isUnviewableBinary(fileName: string, headBytes?: Uint8Array): boolean {
  return describeUnviewableBinary(fileName, headBytes) !== null
}

/**
 * 描述不可内联预览的二进制类型；可以内联预览时返回 null。
 *
 * 返回值包含用户可见的类型标签和「使用系统应用打开」的建议动作，
 * 供交付物卡或预览面板直接展示，不需要再暴露魔数细节。
 */
export function describeUnviewableBinary(
  fileName: string,
  headBytes?: Uint8Array,
): UnviewableBinaryInfo | null {
  if (typeof fileName !== 'string' || fileName.trim() === '') return null
  if (fileName.includes('\0')) return null

  if (headBytes && headBytes.length > 0) {
    // 魔数比扩展名更可信：改了后缀的 zip/exe 仍按二进制处理。
    for (const magic of UNVIEWABLE_MAGICS) {
      if (!matchesMagic(headBytes, magic)) continue
      // docx/xlsx/pptx 本身是 ZIP 容器，但有独立的 Office 预览链路。
      if (magic.format === 'zip' && isOfficeOpenXml(fileName)) continue
      return toInfo(magic)
    }
    // PDF/图片即使扩展名缺失或伪装也保持可预览，避免误拦截已有预览链路。
    for (const magic of VIEWABLE_MAGICS) {
      if (matchesMagic(headBytes, magic)) return null
    }
  }

  const extensionInfo = getExtensionInfo(fileName)
  if (!extensionInfo) return null
  return {
    ...extensionInfo,
    suggestedAction: UNVIEWABLE_BINARY_SUGGESTED_ACTION,
  }
}
