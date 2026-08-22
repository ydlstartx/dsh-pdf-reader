import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergePdfTextSelectionRects,
  pdfTextBlankCaretTarget,
  pdfTextClosestLineFragmentIndexes,
} from '../src/client/pdf-text-selection.ts'

test('adjacent word selections merge into one seamless line highlight', () => {
  assert.deepEqual(mergePdfTextSelectionRects([
    { x: 10, y: 20, width: 38, height: 14 },
    { x: 52, y: 20.5, width: 46, height: 13.5 },
    { x: 99, y: 20, width: 30, height: 14 },
  ]), [
    { x: 10, y: 20, width: 119, height: 14 },
  ])
})

test('separate lines and distant columns remain separate highlights', () => {
  assert.deepEqual(mergePdfTextSelectionRects([
    { x: 10, y: 10, width: 40, height: 12 },
    { x: 180, y: 10, width: 40, height: 12 },
    { x: 10, y: 32, width: 60, height: 12 },
  ]), [
    { x: 10, y: 10, width: 40, height: 12 },
    { x: 180, y: 10, width: 40, height: 12 },
    { x: 10, y: 32, width: 60, height: 12 },
  ])
})

test('trailing paragraph whitespace snaps to the current visual line end', () => {
  const fragments = [
    { left: 20, top: 10, right: 80, bottom: 24 },
    { left: 84, top: 10, right: 150, bottom: 24 },
    { left: 20, top: 34, right: 110, bottom: 48 },
  ]
  assert.deepEqual(pdfTextBlankCaretTarget(fragments, { x: 165, y: 17 }), { fragmentIndex: 1, edge: 'right' })
  assert.deepEqual(pdfTextBlankCaretTarget(fragments, { x: 125, y: 41 }), { fragmentIndex: 2, edge: 'right' })
})

test('leading and inter-word whitespace snap to the nearest same-line boundary', () => {
  const fragments = [
    { left: 20, top: 10, right: 80, bottom: 24 },
    { left: 88, top: 10, right: 150, bottom: 24 },
  ]
  assert.deepEqual(pdfTextBlankCaretTarget(fragments, { x: 8, y: 17 }), { fragmentIndex: 0, edge: 'left' })
  assert.deepEqual(pdfTextBlankCaretTarget(fragments, { x: 83, y: 17 }), { fragmentIndex: 0, edge: 'right' })
  assert.deepEqual(pdfTextBlankCaretTarget(fragments, { x: 86, y: 17 }), { fragmentIndex: 1, edge: 'left' })
})

test('pointer over text does not trigger blank-space snapping', () => {
  const fragments = [
    { left: 20, top: 10, right: 150, bottom: 24 },
    { left: 20, top: 34, right: 160, bottom: 48 },
  ]
  assert.equal(pdfTextBlankCaretTarget(fragments, { x: 120, y: 17 }), undefined)
  assert.equal(pdfTextBlankCaretTarget(fragments, { x: 120, y: 41 }), undefined)
})

test('the nearest visual line wins before an adjacent row can claim its blank', () => {
  const fragments = [
    { left: 20, top: 10, right: 80, bottom: 24 },
    { left: 88, top: 10, right: 150, bottom: 24 },
    { left: 82, top: 26, right: 140, bottom: 40 },
  ]
  const point = { x: 84, y: 23.5 }
  assert.deepEqual(pdfTextClosestLineFragmentIndexes(fragments, point), [0, 1])
  assert.deepEqual(pdfTextBlankCaretTarget(fragments, point), { fragmentIndex: 0, edge: 'right' })
})

test('distant columns use the nearest trailing edge on the same row', () => {
  const fragments = [
    { left: 20, top: 10, right: 100, bottom: 24 },
    { left: 240, top: 10, right: 320, bottom: 24 },
  ]
  assert.deepEqual(pdfTextBlankCaretTarget(fragments, { x: 150, y: 17 }), { fragmentIndex: 0, edge: 'right' })
  assert.deepEqual(pdfTextBlankCaretTarget(fragments, { x: 350, y: 17 }), { fragmentIndex: 1, edge: 'right' })
})
