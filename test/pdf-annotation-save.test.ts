import assert from 'node:assert/strict'
import test from 'node:test'
import {
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFStream,
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  loadPdfTextMarkupAnnotations,
  normalizedPdfRectToAnnotationQuad,
  savePdfTextMarkupAnnotations,
} from '../src/client/pdf-annotation-save.ts'
import type { PdfTextMarkupAnnotation } from '../src/client/pdf-annotations.ts'

function numbers(array: PDFArray): number[] {
  return array.asArray().map(value => value instanceof PDFNumber ? value.asNumber() : Number.NaN)
}

function rounded<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, candidate: unknown) => (
    typeof candidate === 'number' ? Math.round(candidate * 1_000_000) / 1_000_000 : candidate
  ))) as T
}

test('normalized display rectangles map through crop boxes and intrinsic rotation', () => {
  const visibleBox = { x: 10, y: 20, width: 200, height: 100 }
  assert.deepEqual(
    rounded(normalizedPdfRectToAnnotationQuad(
      { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      { visibleBox, intrinsicRotation: 0 },
    )),
    {
      topLeft: { x: 30, y: 100 },
      topRight: { x: 90, y: 100 },
      bottomLeft: { x: 30, y: 60 },
      bottomRight: { x: 90, y: 60 },
    },
  )
  assert.deepEqual(
    rounded(normalizedPdfRectToAnnotationQuad(
      { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      { visibleBox, intrinsicRotation: 90 },
    )),
    {
      topLeft: { x: 50, y: 30 },
      topRight: { x: 50, y: 60 },
      bottomLeft: { x: 130, y: 30 },
      bottomRight: { x: 130, y: 60 },
    },
  )
})

test('ordinary PDFs reuse their immutable source buffer for the render view', async () => {
  const document = await PDFDocument.create()
  document.addPage([100, 100])
  const bytes = await document.save()
  const source = new Uint8Array(bytes).slice().buffer
  const restored = await loadPdfTextMarkupAnnotations(source)
  assert.equal(restored.annotations.length, 0)
  assert.strictEqual(restored.viewBytes.buffer, source)
})

test('markups round-trip as standard PDF annotations with notes and appearances', async () => {
  const sourceDocument = await PDFDocument.create()
  const page = sourceDocument.addPage([300, 400])
  page.setCropBox(10, 20, 200, 100)
  page.setRotation(degrees(90))
  const existing = sourceDocument.context.register(sourceDocument.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [10, 20, 30, 40], Border: [0, 0, 0],
  }))
  page.node.addAnnot(existing)
  const source = await sourceDocument.save()
  const sourceSnapshot = source.slice()
  const annotations: PdfTextMarkupAnnotation[] = [
    {
      id: 'group-1:p1:1',
      groupId: 'group-1',
      kind: 'highlight',
      pageNumber: 1,
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
      text: 'selected text',
      note: '复核这一结论',
      color: 'yellow',
      strokeWidth: 1,
    },
    {
      id: 'group-2:p1:1',
      groupId: 'group-2',
      kind: 'underline',
      pageNumber: 1,
      rects: [{ x: 0.55, y: 0.15, width: 0.25, height: 0.2 }],
      text: 'underlined',
      note: '',
      color: 'blue',
      strokeWidth: 3,
    },
  ]

  const result = await savePdfTextMarkupAnnotations(source, annotations, {
    now: new Date('2026-08-21T00:00:00.000Z'),
    annotationNamespace: 'round-trip',
  })

  assert.deepEqual(source, sourceSnapshot, 'source bytes must remain unchanged')
  assert.equal(result.annotationsWritten, 2)
  assert.equal(result.pagesTouched, 1)
  const saved = await PDFDocument.load(result.bytes, { updateMetadata: false })
  const annots = saved.getPage(0).node.Annots()
  assert.ok(annots)
  assert.equal(annots.size(), 3, 'existing page annotations must be preserved')

  const highlight = annots.lookup(1, PDFDict)
  assert.equal(highlight.lookup(PDFName.of('Subtype'), PDFName).decodeText(), 'Highlight')
  assert.deepEqual(numbers(highlight.lookup(PDFName.of('Rect'), PDFArray)), [50, 30, 130, 60])
  assert.deepEqual(numbers(highlight.lookup(PDFName.of('QuadPoints'), PDFArray)), [50, 30, 50, 60, 130, 30, 130, 60])
  assert.equal(highlight.lookup(PDFName.of('Contents'), PDFHexString).decodeText(), '复核这一结论')
  assert.equal(highlight.lookup(PDFName.of('DSHGroup'), PDFHexString).decodeText(), 'group-1')
  assert.equal(highlight.lookup(PDFName.of('DSHText'), PDFHexString).decodeText(), 'selected text')
  assert.deepEqual(numbers(highlight.lookup(PDFName.of('C'), PDFArray)), [1, 0.847, 0.302])
  assert.ok(highlight.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFStream))

  const underline = annots.lookup(2, PDFDict)
  assert.equal(underline.lookup(PDFName.of('Subtype'), PDFName).decodeText(), 'Underline')
  assert.equal(underline.lookup(PDFName.of('BS'), PDFDict).lookup(PDFName.of('W'), PDFNumber).asNumber(), 3)
  assert.equal(underline.lookupMaybe(PDFName.of('Contents'), PDFHexString), undefined)
  assert.ok(underline.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFStream))

  const loadingTask = getDocument({ data: result.bytes.slice() })
  const pdfjsDocument = await loadingTask.promise
  try {
    const pdfjsAnnotations = await (await pdfjsDocument.getPage(1)).getAnnotations()
    assert.deepEqual(
      pdfjsAnnotations.map(annotation => annotation.subtype),
      ['Link', 'Highlight', 'Underline'],
    )
    assert.equal(pdfjsAnnotations[1]?.contentsObj?.str, '复核这一结论')
  } finally {
    await loadingTask.destroy()
  }

  const restored = await loadPdfTextMarkupAnnotations(result.bytes)
  assert.deepEqual(rounded(restored.annotations), rounded(annotations))
  const viewDocument = await PDFDocument.load(restored.viewBytes, { updateMetadata: false })
  assert.equal(viewDocument.getPage(0).node.Annots()?.size(), 1, 'render copy must retain only the unrelated link')

  const resaved = await savePdfTextMarkupAnnotations(result.bytes, [{
    ...annotations[0]!,
    color: 'green',
    note: 'updated after reopening',
  }], {
    now: new Date('2026-08-21T01:00:00.000Z'),
    annotationNamespace: 'second-save',
  })
  const resavedDocument = await PDFDocument.load(resaved.bytes, { updateMetadata: false })
  const resavedAnnots = resavedDocument.getPage(0).node.Annots()
  assert.equal(resavedAnnots?.size(), 2, 'repeated saves must replace plugin annotations instead of duplicating them')
  const edited = resavedAnnots?.lookup(1, PDFDict)
  assert.equal(edited?.lookup(PDFName.of('Contents'), PDFHexString).decodeText(), 'updated after reopening')
  assert.deepEqual(edited === undefined ? [] : numbers(edited.lookup(PDFName.of('C'), PDFArray)), [0.451, 0.835, 0.604])
})

test('invalid annotation pages and rectangles reject before producing a saved file', async () => {
  const document = await PDFDocument.create()
  document.addPage([100, 100])
  const source = await document.save()
  const base: PdfTextMarkupAnnotation = {
    id: 'invalid', groupId: 'invalid', kind: 'highlight', pageNumber: 2,
    rects: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
    text: '', note: '', color: 'yellow', strokeWidth: 1,
  }
  await assert.rejects(savePdfTextMarkupAnnotations(source, [base]), /页码无效/)
  await assert.rejects(savePdfTextMarkupAnnotations(source, [{
    ...base,
    pageNumber: 1,
    rects: [{ x: 0.8, y: 0.8, width: 0.5, height: 0.5 }],
  }]), /无效页面坐标/)
})

test('annotations saved before editable metadata was introduced remain recoverable', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([100, 100])
  const legacy = document.context.register(document.context.obj({
    Type: 'Annot',
    Subtype: 'Underline',
    Rect: [10, 70, 50, 80],
    QuadPoints: [10, 80, 50, 80, 10, 70, 50, 70],
    C: [0.475, 0.722, 1],
    BS: { Type: 'Border', W: 3, S: 'S' },
    NM: PDFHexString.fromText('dsh-pdf-reader:legacy-save:1'),
    Contents: PDFHexString.fromText('legacy note'),
  }))
  page.node.addAnnot(legacy)

  const restored = await loadPdfTextMarkupAnnotations(await document.save())
  assert.equal(restored.annotations.length, 1)
  assert.deepEqual(rounded(restored.annotations[0]), {
    id: 'dsh-pdf-reader:legacy-save:1:group:p1:1',
    groupId: 'dsh-pdf-reader:legacy-save:1:group',
    kind: 'underline',
    pageNumber: 1,
    rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.1 }],
    text: '',
    note: 'legacy note',
    color: 'blue',
    strokeWidth: 3,
  })
  const viewDocument = await PDFDocument.load(restored.viewBytes, { updateMetadata: false })
  assert.equal(viewDocument.getPage(0).node.Annots()?.size(), 0)
})
