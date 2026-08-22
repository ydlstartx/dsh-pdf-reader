import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addPdfEvidenceImage,
  addPdfTextEvidence,
  boundedPdfEvidenceImages,
  boundedPdfTextEvidence,
  pdfTextEvidenceSources,
  pdfTextEvidenceReferences,
  reconcilePdfEvidenceSelection,
} from '../src/client/pdf-evidence.ts'

const first = {
  id: 'text-1',
  documentId: 'document-a-1234',
  documentName: 'GPU.pdf',
  text: 'Shared memory is on chip.',
  drafts: [{ pageNumber: 7, text: 'Shared memory is on chip.', rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.03 }] }],
} as const
const second = {
  id: 'text-2',
  documentId: 'document-b-1234',
  documentName: 'CPU.pdf',
  text: 'Registers are private.',
  drafts: [{ pageNumber: 8, text: 'Registers are private.', rects: [{ x: 0.2, y: 0.4, width: 0.4, height: 0.03 }] }],
} as const

test('text evidence appends in order and ignores the exact same source', () => {
  const added = addPdfTextEvidence([], first)
  assert.equal(added.added, true)
  assert.deepEqual(added.sources, [first])

  const duplicate = addPdfTextEvidence(added.sources, { ...first, id: 'another-id' })
  assert.equal(duplicate.added, false)
  assert.strictEqual(duplicate.sources, added.sources)

  const sameTextElsewhere = addPdfTextEvidence(added.sources, {
    ...first,
    id: 'text-elsewhere',
    drafts: [{ ...first.drafts[0], rects: [{ x: 0.1, y: 0.6, width: 0.5, height: 0.03 }] }],
  })
  assert.equal(sameTextElsewhere.added, true)

  const sameGeometryInAnotherPdf = addPdfTextEvidence(added.sources, {
    ...first,
    id: 'other-document',
    documentId: second.documentId,
    documentName: second.documentName,
  })
  assert.equal(sameGeometryInAnotherPdf.added, true)
})

test('references combine stored and live text without duplicates', () => {
  const sources = pdfTextEvidenceSources([first], second)
  assert.deepEqual(sources, [first, { ...second, id: 'live' }])
  const combined = pdfTextEvidenceReferences([first], second)
  assert.deepEqual(combined.map(reference => reference.pageNumbers), [[7], [8]])
  assert.deepEqual(combined.map(reference => reference.text), [first.text, second.text])
  assert.deepEqual(combined.map(reference => reference.documentName), ['GPU.pdf', 'CPU.pdf'])

  const duplicate = pdfTextEvidenceReferences([first], first)
  assert.equal(duplicate.length, 1)
})

test('evidence participation preserves exclusions and selects new material', () => {
  const image1 = { id: 'image-1' }
  const image2 = { id: 'image-2' }
  const image3 = { id: 'image-3' }
  assert.deepEqual(
    reconcilePdfEvidenceSelection([image1], new Set([image1, image2]), [image1, image2, image3]),
    [image1, image3],
  )
  assert.deepEqual(
    reconcilePdfEvidenceSelection([image1, image2], new Set([image1, image2]), [image2]),
    [image2],
  )
})

test('image evidence is bounded before reusable Base64 data can grow without limit', () => {
  const image1 = { id: 'image-1', pngBase64: 'AQID' }
  const image2 = { id: 'image-2', pngBase64: 'BAUG' }
  assert.deepEqual(addPdfEvidenceImage([], image1, 2, 6), [image1])
  assert.deepEqual(addPdfEvidenceImage([image1], image2, 2, 6), [image1, image2])
  assert.throws(() => addPdfEvidenceImage([image1, image2], image2, 2, 9), /最多 2 张/)
  assert.throws(() => addPdfEvidenceImage([image1], image2, 3, 5), /总量过大/)
  assert.deepEqual(boundedPdfEvidenceImages([image1, image2], 3, 5), [image1])
})

test('invalid and excessive evidence is rejected explicitly', () => {
  assert.throws(() => addPdfTextEvidence([], { ...first, text: '   ' }), /没有可加入/)
  assert.throws(() => addPdfTextEvidence([], { ...first, drafts: [] }), /缺少有效 PDF 页码/)
  const full = Array.from({ length: 20 }, (_, index) => ({ ...first, id: `text-${String(index)}`, text: `text ${String(index)}` }))
  assert.throws(() => addPdfTextEvidence(full, second), /最多 20 段/)
})

test('legacy text evidence restore skips invalid entries and remains bounded', () => {
  const restored = boundedPdfTextEvidence([
    { ...first, text: '   ' },
    first,
    { ...first, id: 'duplicate' },
    second,
  ])
  assert.deepEqual(restored, [first, second])
})
