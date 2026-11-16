import { describe, expect, test } from 'bun:test'
import {
  PDF_PREVIEW_MIME_TYPE,
  PDF_ZOOM_MAX,
  PDF_ZOOM_MIN,
  buildPdfPreviewHtml,
  clampPdfZoom,
  escapeInlineScriptJson,
  isPdfPreviewPath,
  pdfZoomPercent,
  resolvePdfPreviewMimeType,
  stepPdfZoom,
} from './pdf-preview-html'

const baseOptions = {
  fileUrl: 'proma-file://file-token',
  pdfScriptUrl: 'proma-file://script-token',
  pdfWorkerUrl: 'proma-file://worker-token',
  standardFontDataUrl: 'proma-file://fonts-token/',
}

describe('PDF 预览路径与 MIME', () => {
  test('Given .pdf 路径 When 解析 MIME Then 返回 application/pdf', () => {
    expect(resolvePdfPreviewMimeType('C:\\docs\\report.pdf')).toBe(PDF_PREVIEW_MIME_TYPE)
    expect(resolvePdfPreviewMimeType('/home/user/report.pdf')).toBe(PDF_PREVIEW_MIME_TYPE)
  })

  test('Given 大写扩展名 When 解析 MIME Then 仍识别为 PDF', () => {
    expect(resolvePdfPreviewMimeType('/docs/REPORT.PDF')).toBe(PDF_PREVIEW_MIME_TYPE)
  })

  test('Given 非 PDF 或无可判定扩展名 When 解析 MIME Then 返回 null', () => {
    expect(resolvePdfPreviewMimeType('/docs/report.txt')).toBeNull()
    expect(resolvePdfPreviewMimeType('/docs/report.pdfx')).toBeNull()
    expect(resolvePdfPreviewMimeType('/docs/pdf')).toBeNull()
    expect(resolvePdfPreviewMimeType('/docs/.pdf')).toBeNull()
    expect(resolvePdfPreviewMimeType('')).toBeNull()
  })

  test('Given 路径含目录点号 When 解析 MIME Then 只按文件名扩展名判断', () => {
    expect(resolvePdfPreviewMimeType('/a.b/report.pdf')).toBe(PDF_PREVIEW_MIME_TYPE)
    expect(resolvePdfPreviewMimeType('/a.b/report')).toBeNull()
  })

  test('Given 路径 When isPdfPreviewPath Then 与 MIME 判定一致', () => {
    expect(isPdfPreviewPath('/docs/report.pdf')).toBe(true)
    expect(isPdfPreviewPath('/docs/report.txt')).toBe(false)
  })
})

describe('PDF 页面缩放参数', () => {
  test('Given 越界倍率 When clamp Then 收敛到 0.1–5', () => {
    expect(clampPdfZoom(0.05)).toBe(PDF_ZOOM_MIN)
    expect(clampPdfZoom(6)).toBe(PDF_ZOOM_MAX)
    expect(clampPdfZoom(1.5)).toBe(1.5)
  })

  test('Given 非有限倍率 When clamp Then 回退到 1', () => {
    expect(clampPdfZoom(Number.NaN)).toBe(1)
    expect(clampPdfZoom(Number.POSITIVE_INFINITY)).toBe(1)
  })

  test('Given 当前倍率 When 放大/缩小 Then 按 1.25 / 0.8 步进', () => {
    expect(stepPdfZoom(1, 'in')).toBe(1.25)
    expect(stepPdfZoom(1, 'out')).toBe(0.8)
    expect(stepPdfZoom(4.5, 'in')).toBe(PDF_ZOOM_MAX)
    expect(stepPdfZoom(0.12, 'out')).toBe(PDF_ZOOM_MIN)
  })

  test('Given 非法当前倍率 When 步进 Then 以 1 为基准', () => {
    expect(stepPdfZoom(0, 'in')).toBe(1.25)
    expect(stepPdfZoom(Number.NaN, 'out')).toBe(0.8)
  })

  test('Given 渲染倍率 When 转百分比 Then 四舍五入并夹在 10–500', () => {
    expect(pdfZoomPercent(0.873)).toBe(87)
    expect(pdfZoomPercent(1)).toBe(100)
    expect(pdfZoomPercent(0.01)).toBe(10)
    expect(pdfZoomPercent(99)).toBe(500)
    expect(pdfZoomPercent(Number.NaN)).toBe(100)
  })
})

describe('PDF 预览 HTML 生成', () => {
  test('Given 四个资源 URL When 生成 HTML Then 各自内联且带 UTF-8 声明', () => {
    const html = buildPdfPreviewHtml(baseOptions)
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html.split(baseOptions.fileUrl)).toHaveLength(2)
    expect(html.split(baseOptions.pdfScriptUrl)).toHaveLength(2)
    expect(html.split(baseOptions.pdfWorkerUrl)).toHaveLength(2)
    expect(html.split(baseOptions.standardFontDataUrl)).toHaveLength(2)
  })

  test('Given viewer HTML When 检查交互行为 Then 包含适应宽度、缩放夹取与过期渲染丢弃', () => {
    const html = buildPdfPreviewHtml(baseOptions)
    expect(html).toContain("e.data?.type === 'pdf-fit-width'")
    expect(html).toContain('e.source !== window.parent')
    expect(html).toContain('Math.max(ZOOM_MIN, Math.min(ZOOM_MAX')
    expect(html).toContain('renderSequence')
    expect(html).toContain('replaceChildren')
    expect(html).toContain('Math.ceil(vp.width)')
  })

  test('Given PDF 加载失败 When 写入错误 Then 使用 textContent 而不是 innerHTML', () => {
    const html = buildPdfPreviewHtml(baseOptions)
    expect(html).toContain("container.textContent = 'PDF 加载失败: '")
    expect(html).not.toContain('container.innerHTML')
  })

  test('Given URL 含 </script> When 内联 Then 不截断脚本块', () => {
    const html = buildPdfPreviewHtml({
      ...baseOptions,
      fileUrl: 'proma-file://token/"></script><script>alert(1)</script>',
    })
    // 仅保留模板自身的结束标签；参数中的结束标签必须被转义。
    expect(html.split('</script>')).toHaveLength(2)
    expect(html).toContain('\\u003c/script\\u003e')
    expect(html).not.toContain('"></script><script>')
  })

  test('Given 含引号与反斜杠的路径 When 内联 Then 仍是合法字符串字面量', () => {
    const fileUrl = 'proma-file://token/C:\\docs\\"quoted".pdf'
    const html = buildPdfPreviewHtml({ ...baseOptions, fileUrl })
    expect(html).toContain(escapeInlineScriptJson(fileUrl))
    expect(html).toContain('C:\\\\docs\\\\\\"quoted\\".pdf')
  })
})

describe('内联脚本 JSON 转义', () => {
  test('Given 普通字符串 When 转义 Then 保留引号并原样输出', () => {
    expect(escapeInlineScriptJson('abc')).toBe('"abc"')
  })

  test('Given 脚本敏感字符 When 转义 Then < > & 与行分隔符均被编码', () => {
    const escaped = escapeInlineScriptJson('</script>&\u2028\u2029')
    expect(escaped).toBe('"\\u003c/script\\u003e\\u0026\\u2028\\u2029"')
    expect(escaped).not.toContain('</script>')
  })
})
