import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendPdfCitationBatch,
  formatPdfCitationUrl,
  MAX_PDF_CITATION_BATCHES,
  parsePdfCitationBatchId,
  parsePdfCitationLabelAt,
  parsePdfCitationUrl,
  resolvePdfCitation,
} from '../src/client/pdf-citations.ts'
import type { PdfCitationBatch } from '../src/client/pdf-citations.ts'
import { formatPdfDocumentCitationUrl } from '../src/pdf-document-index.ts'

function batch(id: string): PdfCitationBatch {
  return {
    id,
    documentName: 'GPU.pdf',
    images: [{
      documentId: 'document-a-1234',
      documentName: 'GPU.pdf',
      pageNumber: 3,
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      rotation: 90,
    }],
    texts: [{
      id: `${id}-text`,
      documentId: 'document-b-1234',
      documentName: 'Notes.pdf',
      text: 'Shared memory is on chip.',
      drafts: [{
        pageNumber: 4,
        text: 'Shared memory is on chip.',
        rects: [{ x: 0.15, y: 0.6, width: 0.7, height: 0.04 }],
      }],
    }],
  }
}

test('PDF citation URLs round-trip only the reserved local sentinel', () => {
  const href = formatPdfCitationUrl('pdf-7-2', 'text', 0)
  assert.equal(href, 'https://dsh-pdf.invalid/source/pdf-7-2/text/1')
  assert.deepEqual(parsePdfCitationUrl(href), { batchId: 'pdf-7-2', kind: 'text', index: 0 })
  assert.equal(parsePdfCitationUrl('https://example.com/source/pdf-7-2/text/1'), undefined)
  assert.equal(parsePdfCitationUrl(`${href}?unexpected=1`), undefined)
  assert.equal(parsePdfCitationUrl('https://dsh-pdf.invalid/source/pdf-7-2/text/0'), undefined)
  assert.throws(() => formatPdfCitationUrl('../bad', 'image', 0), /批次标识无效/)
})

test('whole-document tool citations round-trip exact page text offsets', () => {
  const href = formatPdfDocumentCitationUrl('0abc1230def456', 12, 100, 135)
  const reference = {
    kind: 'document' as const,
    documentId: '0abc1230def456',
    pageNumber: 12,
    offset: 100,
    endOffset: 135,
  }
  assert.deepEqual(parsePdfCitationUrl(href), reference)
  assert.deepEqual(resolvePdfCitation([], reference), { kind: 'document', source: reference })
  assert.equal(parsePdfCitationUrl('https://dsh-pdf.invalid/document/short/page/1/0/1'), undefined)
  assert.equal(parsePdfCitationUrl('https://dsh-pdf.invalid/document/0abc1230def456/page/1/9/2'), undefined)
})

test('plain model citation labels recover the exact prompt batch at the clicked offset', () => {
  const prompt = [
    '引用规则：',
    '- 图片 1：[图 1](https://dsh-pdf.invalid/source/pdf-9-3/image/1)',
    '- 文字 1：[文 1](https://dsh-pdf.invalid/source/pdf-9-3/text/1)',
  ].join('\n')
  assert.equal(parsePdfCitationBatchId(prompt), 'pdf-9-3')

  const answer = '共享内存的位置由 [图 1] 说明，访问代价由 [文 12] 说明。'
  assert.deepEqual(
    parsePdfCitationLabelAt(answer, answer.indexOf('图 1') + 1, 'pdf-9-3'),
    { batchId: 'pdf-9-3', kind: 'image', index: 0 },
  )
  assert.deepEqual(
    parsePdfCitationLabelAt(answer, answer.indexOf('文 12') + 2, 'pdf-9-3'),
    { batchId: 'pdf-9-3', kind: 'text', index: 11 },
  )
  assert.equal(parsePdfCitationLabelAt(answer, 0, 'pdf-9-3'), undefined)
})

test('plain citation recovery rejects mixed prompt batches and unrelated labels', () => {
  const mixed = [
    'https://dsh-pdf.invalid/source/pdf-a/image/1',
    'https://dsh-pdf.invalid/source/pdf-b/text/1',
  ].join('\n')
  assert.equal(parsePdfCitationBatchId(mixed), undefined)
  assert.equal(parsePdfCitationBatchId('普通回答 [图 1]'), undefined)
  assert.equal(parsePdfCitationLabelAt('[图片 1]', 2, 'pdf-a'), undefined)
  assert.equal(parsePdfCitationLabelAt('[图 0]', 2, 'pdf-a'), undefined)
})

test('citation batches resolve exact image and text geometry', () => {
  const stored = appendPdfCitationBatch([], batch('pdf-1-1'))
  assert.deepEqual(
    resolvePdfCitation(stored, { batchId: 'pdf-1-1', kind: 'image', index: 0 }),
    { kind: 'image', source: batch('pdf-1-1').images[0] },
  )
  assert.equal(
    resolvePdfCitation(stored, { batchId: 'pdf-1-1', kind: 'text', index: 0 })?.kind,
    'text',
  )
  assert.equal(resolvePdfCitation(stored, { batchId: 'pdf-1-1', kind: 'text', index: 1 }), undefined)
  assert.equal(resolvePdfCitation(stored, { batchId: 'missing', kind: 'image', index: 0 }), undefined)
})

test('citation history remains bounded and replaces duplicate batch ids', () => {
  let stored: readonly PdfCitationBatch[] = []
  for (let index = 0; index < MAX_PDF_CITATION_BATCHES + 3; index += 1) {
    stored = appendPdfCitationBatch(stored, batch(`pdf-1-${String(index)}`))
  }
  assert.equal(stored.length, MAX_PDF_CITATION_BATCHES)
  assert.equal(stored[0]?.id, 'pdf-1-3')
  stored = appendPdfCitationBatch(stored, { ...batch('pdf-1-3'), documentName: 'updated.pdf' })
  assert.equal(stored.length, MAX_PDF_CITATION_BATCHES)
  assert.equal(stored.at(-1)?.documentName, 'updated.pdf')
})
