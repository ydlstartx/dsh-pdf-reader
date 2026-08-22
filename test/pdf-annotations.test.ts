import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPdfTextMarkupAnnotations,
  groupPdfTextMarkupAnnotations,
  pdfMarkupStrokeWidthCssPixels,
  removePdfTextMarkupGroup,
  updatePdfTextMarkupGroupColor,
  updatePdfTextMarkupGroupNote,
  updatePdfTextMarkupGroupStrokeWidth,
} from '../src/client/pdf-annotations.ts'

test('saved PDF line widths preview through the active page scale', () => {
  assert.equal(pdfMarkupStrokeWidthCssPixels(1, 0.75), 0.75)
  assert.equal(pdfMarkupStrokeWidthCssPixels(2, 1.25), 2.5)
  assert.equal(pdfMarkupStrokeWidthCssPixels(3, 2), 6)
})

test('cross-page text-markup drafts become one stable annotation group', () => {
  const annotations = createPdfTextMarkupAnnotations([
    { pageNumber: 2, rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }], text: 'selected text' },
    { pageNumber: 3, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.04 }], text: 'selected text' },
  ], 'highlight', 'yellow', 2, 'markup-7')

  assert.deepEqual(annotations.map(annotation => ({
    id: annotation.id,
    groupId: annotation.groupId,
    pageNumber: annotation.pageNumber,
    kind: annotation.kind,
    color: annotation.color,
    strokeWidth: annotation.strokeWidth,
  })), [
    { id: 'markup-7:p2:1', groupId: 'markup-7', pageNumber: 2, kind: 'highlight', color: 'yellow', strokeWidth: 2 },
    { id: 'markup-7:p3:2', groupId: 'markup-7', pageNumber: 3, kind: 'highlight', color: 'yellow', strokeWidth: 2 },
  ])
})

test('kind, color, note, and delete operations apply to the complete markup group', () => {
  const original = createPdfTextMarkupAnnotations([
    { pageNumber: 1, rects: [{ x: 0, y: 0, width: 0.2, height: 0.1 }], text: 'one' },
    { pageNumber: 2, rects: [{ x: 0, y: 0, width: 0.2, height: 0.1 }], text: 'one' },
  ], 'underline', 'yellow', 1, 'group-a')

  assert.deepEqual(original.map(annotation => annotation.kind), ['underline', 'underline'])

  const recolored = updatePdfTextMarkupGroupColor(original, 'group-a', 'blue')
  assert.deepEqual(recolored.map(annotation => annotation.color), ['blue', 'blue'])
  const widened = updatePdfTextMarkupGroupStrokeWidth(recolored, 'group-a', 3)
  assert.deepEqual(widened.map(annotation => annotation.strokeWidth), [3, 3])
  const noted = updatePdfTextMarkupGroupNote(widened, 'group-a', '  review this claim  ')
  assert.deepEqual(noted.map(annotation => annotation.note), ['review this claim', 'review this claim'])
  assert.equal(removePdfTextMarkupGroup(noted, 'group-a').length, 0)
})

test('strikeout is retained as a first-class text-markup kind', () => {
  const [annotation] = createPdfTextMarkupAnnotations([
    { pageNumber: 4, rects: [{ x: 0.2, y: 0.3, width: 0.15, height: 0.025 }], text: 'remove this' },
  ], 'strikeout', 'pink', 2, 'group-strike')

  assert.equal(annotation?.kind, 'strikeout')
  assert.equal(annotation?.color, 'pink')
  assert.equal(annotation?.strokeWidth, 2)
})

test('annotation center groups page-local members for a stable document list', () => {
  const later = createPdfTextMarkupAnnotations([
    { pageNumber: 8, rects: [{ x: 0.2, y: 0.3, width: 0.2, height: 0.04 }], text: 'later' },
  ], 'strikeout', 'pink', 2, 'group-later')
  const crossPage = updatePdfTextMarkupGroupNote(createPdfTextMarkupAnnotations([
    { pageNumber: 4, rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }], text: 'shared excerpt' },
    { pageNumber: 2, rects: [{ x: 0.1, y: 0.1, width: 0.25, height: 0.04 }], text: 'shared excerpt' },
  ], 'highlight', 'yellow', 1, 'group-cross'), 'group-cross', 'review')

  const groups = groupPdfTextMarkupAnnotations([...later, ...crossPage])
  assert.deepEqual(groups.map(group => ({
    id: group.groupId,
    kind: group.kind,
    pages: group.pageNumbers,
    text: group.text,
    note: group.note,
    firstPage: group.first.pageNumber,
  })), [
    { id: 'group-cross', kind: 'highlight', pages: [2, 4], text: 'shared excerpt', note: 'review', firstPage: 2 },
    { id: 'group-later', kind: 'strikeout', pages: [8], text: 'later', note: '', firstPage: 8 },
  ])
})
