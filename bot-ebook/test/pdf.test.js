import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText } from '../lib/pdf.js';

/** 手写一个最小「文字版」PDF：单页 + Helvetica 文本，够 pdfjs 抽字。 */
function minimalPdf(text) {
  const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach(o => { pdf += `${String(o).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

test('extractPdfText 从文字版 PDF 抽字', async () => {
  const text = await extractPdfText(new TextEncoder().encode(minimalPdf('Hello PDF World')));
  assert.match(text, /Hello PDF World/);
});

test('extractPdfText 对空输入抛 EMPTY_EXTRACT', async () => {
  await assert.rejects(() => extractPdfText(new Uint8Array(0)), error => error.code === 'EMPTY_EXTRACT');
});
