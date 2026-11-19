/**
 * PDF 抽文字（针对文字版 PDF）。pdfjs-dist 是纯 JS，这里动态 import：
 * 只有真的导入 PDF 时才加载，宿主没装 pdfjs-dist 也不会在启动时崩。
 */
export async function extractPdfText(data) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
  if (!bytes.length) throw Object.assign(new Error('空文件'), { code: 'EMPTY_EXTRACT' });
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, disableFontFace: true }).promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = (content.items || []).map(item => (item && typeof item.str === 'string' ? item.str : '')).join(' ');
      pages.push(text);
    }
  } finally {
    try { await doc.destroy(); } catch { /* already destroyed */ }
  }
  return pages.join('\n\n');
}
