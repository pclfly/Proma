/**
 * 内联 PDF 预览 HTML 生成。
 *
 * 官方 0.22.0 的 `pdf-preview-html.ts` 只是把 pdf.js viewer 放在一个模板字符串里；
 * 差分报告中的 105060 行是 esbuild 打包区段（到下一个 `// src/...` 标记之间，
 * 含 underscore/bluebird 等内联依赖），不是源文件本身。因此这里不复制生成物，
 * 而是由本地维护同一套 viewer 行为，并复用本地已有的 `pdfjs-dist` 依赖。
 *
 * 设计要点：
 * - 默认适应宽度；手动缩放后固定倍率，范围 0.1–5。
 * - 渲染序列号丢弃过期的异步渲染，避免快速缩放时画布重复或错序。
 * - 错误信息用 textContent 写入，不拼接 innerHTML。
 * - 所有 URL 以脚本安全的方式内联，防止 `</script>` 截断内联脚本。
 */

export interface PdfPreviewHtmlOptions {
  fileUrl: string
  pdfScriptUrl: string
  pdfWorkerUrl: string
  standardFontDataUrl: string
}

export const PDF_PREVIEW_MIME_TYPE = 'application/pdf'
export const PDF_ZOOM_MIN = 0.1
export const PDF_ZOOM_MAX = 5
const PDF_ZOOM_IN_FACTOR = 1.25
const PDF_ZOOM_OUT_FACTOR = 0.8

/**
 * 扩展名 → 预览 MIME。只做扩展名判定，不猜测文件内容；
 * 非 PDF 返回 null，调用方据此拒绝进入 pdf.js 渲染路径。
 */
export function resolvePdfPreviewMimeType(filePath: string): string | null {
  const name = filePath.split(/[\\/]/).pop() ?? ''
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0) return null
  return name.slice(dotIndex).toLowerCase() === '.pdf' ? PDF_PREVIEW_MIME_TYPE : null
}

export function isPdfPreviewPath(filePath: string): boolean {
  return resolvePdfPreviewMimeType(filePath) !== null
}

/** 把缩放倍率夹到 [0.1, 5]；非有限值按 1 处理。 */
export function clampPdfZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, scale))
}

/** 按方向步进缩放倍率，并与 viewer 内的 1.25 / 0.8 保持一致。 */
export function stepPdfZoom(currentScale: number, direction: 'in' | 'out'): number {
  const base = Number.isFinite(currentScale) && currentScale > 0 ? currentScale : 1
  return clampPdfZoom(base * (direction === 'in' ? PDF_ZOOM_IN_FACTOR : PDF_ZOOM_OUT_FACTOR))
}

/** 缩放百分比（viewer 通过 postMessage 回报给外层工具栏）。 */
export function pdfZoomPercent(scale: number): number {
  return Math.round(clampPdfZoom(scale) * 100)
}

/**
 * JSON 序列化并转义脚本上下文敏感字符。
 * JSON.stringify 本身不会处理 `</script>`，文件名在部分平台可以包含 `<`/`>`，
 * 直接内联会提前结束脚本块。
 */
export function escapeInlineScriptJson(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function buildPdfPreviewHtml({
  fileUrl,
  pdfScriptUrl,
  pdfWorkerUrl,
  standardFontDataUrl,
}: PdfPreviewHtmlOptions): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; overflow: auto; padding: 16px; }
  #c { display: flex; flex-direction: column; align-items: center; gap: 12px; width: max-content; min-width: 100%; }
  #c canvas { flex: none; box-shadow: 0 2px 8px rgba(0,0,0,0.15); display: block; }
  .loading { color: #888; font: 12px/1.5 system-ui; padding: 40px; text-align: center; width: 100%; }
  .error { color: #f87171; font: 12px/1.5 system-ui; padding: 20px; text-align: center; width: 100%; }
  .page-info { color: #888; font: 11px/1.5 system-ui; text-align: center; padding: 4px; width: 100%; }
</style>
</head><body>
  <div class="loading" id="c">正在加载 PDF...</div>
  <script type="module">
    const container = document.getElementById('c');
    const fileUrl = ${escapeInlineScriptJson(fileUrl)};
    const pdfScriptUrl = ${escapeInlineScriptJson(pdfScriptUrl)};
    const pdfWorkerUrl = ${escapeInlineScriptJson(pdfWorkerUrl)};
    const standardFontDataUrl = ${escapeInlineScriptJson(standardFontDataUrl)};
    const ZOOM_MIN = ${PDF_ZOOM_MIN};
    const ZOOM_MAX = ${PDF_ZOOM_MAX};
    const ZOOM_IN = ${PDF_ZOOM_IN_FACTOR};
    const ZOOM_OUT = ${PDF_ZOOM_OUT_FACTOR};
    // null 为适应宽度；手动缩放后才固定倍率。
    let zoomScale = null;
    let firstPageScale = 1;
    let renderSequence = 0;
    let pdfDoc = null;

    // 页面组窄于视口时由 flex 居中；放大产生横向溢出时，让视口对准页面组中心。
    function centerPages() {
      const root = document.documentElement;
      window.scrollTo({ left: Math.max(0, (root.scrollWidth - root.clientWidth) / 2), top: window.scrollY });
    }

    function showError(err) {
      container.className = 'error';
      container.textContent = 'PDF 加载失败: ' + (err && err.message ? err.message : String(err));
    }

    async function renderAll() {
      if (!pdfDoc) return;
      const sequence = ++renderSequence;
      container.className = '';
      const requestedScale = zoomScale;
      const availableWidth = Math.max(1, document.documentElement.clientWidth - 32);
      const fragment = document.createDocumentFragment();
      const dpr = window.devicePixelRatio || 1;
      let renderedScale = 1;
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        if (sequence !== renderSequence) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = requestedScale ?? availableWidth / baseViewport.width;
        if (i === 1) renderedScale = scale;
        const vp = page.getViewport({ scale: scale * dpr });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        canvas.style.width = (vp.width / dpr) + 'px';
        canvas.style.height = (vp.height / dpr) + 'px';
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        if (sequence !== renderSequence) return;
        fragment.appendChild(canvas);
      }
      const info = document.createElement('div');
      info.className = 'page-info';
      info.textContent = '共 ' + pdfDoc.numPages + ' 页';
      fragment.appendChild(info);
      container.replaceChildren(fragment);
      centerPages();
      firstPageScale = renderedScale;
      window.parent.postMessage({ type: 'pdf-zoom-changed', zoom: Math.round(renderedScale * 100) }, '*');
    }

    function renderWithErrorHandling() {
      return renderAll().catch(showError);
    }

    window.addEventListener('message', (e) => {
      if (e.source !== window.parent) return;
      if (e.data?.type === 'pdf-fit-width') {
        zoomScale = null;
        return renderWithErrorHandling();
      }
      if (e.data?.type === 'pdf-zoom' && (e.data.direction === 'in' || e.data.direction === 'out')) {
        const currentScale = typeof zoomScale === 'number' ? zoomScale : firstPageScale;
        if (!Number.isFinite(currentScale) || currentScale <= 0) return;
        zoomScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, currentScale * (e.data.direction === 'in' ? ZOOM_IN : ZOOM_OUT)));
        return renderWithErrorHandling();
      }
    });
    window.addEventListener('resize', () => {
      if (zoomScale === null) return renderWithErrorHandling();
      centerPages();
    });

    try {
      const pdfjsLib = await import(pdfScriptUrl);
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      pdfDoc = await pdfjsLib.getDocument({
        url: fileUrl,
        standardFontDataUrl,
      }).promise;
      await renderAll();
    } catch (err) {
      showError(err);
    }
  </script>
</body></html>`
}
