import assert from 'node:assert/strict'
import test from 'node:test'
import {
  currentPdfOutlineItemId,
  flattenPdfOutline,
  outlineDestinationPage,
  pdfOutlineAncestorIds,
  visibleCurrentPdfOutlineItemId,
  visiblePdfOutlineItems,
} from '../src/client/pdf-outline.ts'
import type { RawPdfOutlineNode } from '../src/client/pdf-outline.ts'

const node = (
  title: string,
  dest: string | readonly unknown[] | null,
  items: readonly RawPdfOutlineNode[] = [],
): RawPdfOutlineNode => ({ title, dest, url: null, items })

test('outline flattening preserves document order, depth, and destination capability', () => {
  const rows = flattenPdfOutline([
    node(' Chapter 1 ', [{ num: 1, gen: 0 }], [
      node('Section 1.1', 'named-section'),
      node('External only', null),
    ]),
    node('', [4]),
  ])

  assert.deepEqual(rows.map(({ destination: _destination, ...row }) => row), [
    { id: '1', parentId: null, title: 'Chapter 1', depth: 0, hasChildren: true, navigable: true },
    { id: '1.1', parentId: '1', title: 'Section 1.1', depth: 1, hasChildren: false, navigable: true },
    { id: '1.2', parentId: '1', title: 'External only', depth: 1, hasChildren: false, navigable: false },
    { id: '2', parentId: null, title: '未命名书签', depth: 0, hasChildren: false, navigable: true },
  ])
})

test('outline flattening enforces its caller-provided DOM row bound', () => {
  const rows = flattenPdfOutline([node('A', [0]), node('B', [1]), node('C', [2])], 2)
  assert.deepEqual(rows.map(row => row.title), ['A', 'B'])
})

test('outline visibility starts collapsed and follows only expanded ancestors', () => {
  const rows = flattenPdfOutline([
    node('Chapter 1', [0], [node('Section 1.1', [1], [node('Topic', [2])])]),
    node('Chapter 2', [3]),
  ])

  assert.deepEqual(visiblePdfOutlineItems(rows, new Set()).map(row => row.title), [
    'Chapter 1',
    'Chapter 2',
  ])
  assert.deepEqual(visiblePdfOutlineItems(rows, new Set(['1'])).map(row => row.title), [
    'Chapter 1',
    'Section 1.1',
    'Chapter 2',
  ])
  assert.deepEqual(visiblePdfOutlineItems(rows, new Set(['1', '1.1'])).map(row => row.title), [
    'Chapter 1',
    'Section 1.1',
    'Topic',
    'Chapter 2',
  ])
})

test('a truncated outline does not expose an expand control with no retained child', () => {
  const rows = flattenPdfOutline([node('Chapter', [0], [node('Hidden child', [1])])], 1)
  assert.equal(rows[0]?.hasChildren, false)
})

test('current outline follows the closest preceding destination and prefers depth on page ties', () => {
  const rows = flattenPdfOutline([
    node('Chapter 1', [0], [
      node('Section 1.1', [0]),
      node('Section 1.2', [4]),
    ]),
    node('Chapter 2', [9]),
  ])
  const pages = new Map([
    ['1', 1],
    ['1.1', 1],
    ['1.2', 5],
    ['2', 10],
  ])

  assert.equal(currentPdfOutlineItemId(rows, pages, 0), undefined)
  assert.equal(currentPdfOutlineItemId(rows, pages, 1), '1.1')
  assert.equal(currentPdfOutlineItemId(rows, pages, 8), '1.2')
  assert.equal(currentPdfOutlineItemId(rows, pages, 10), '2')
})

test('collapsed current entries highlight a visible ancestor until explicitly revealed', () => {
  const rows = flattenPdfOutline([
    node('Chapter', [0], [node('Section', [1], [node('Topic', [2])])]),
  ])

  assert.equal(visibleCurrentPdfOutlineItemId(rows, new Set(), '1.1.1'), '1')
  assert.equal(visibleCurrentPdfOutlineItemId(rows, new Set(['1']), '1.1.1'), '1.1')
  assert.equal(visibleCurrentPdfOutlineItemId(rows, new Set(['1', '1.1']), '1.1.1'), '1.1.1')
  assert.deepEqual(pdfOutlineAncestorIds(rows, '1.1.1'), ['1', '1.1'])
})

test('outline destinations resolve named, referenced, and numeric pages safely', async () => {
  const doc = {
    numPages: 8,
    getDestination: async (id: string) => id === 'chapter' ? [{ num: 20, gen: 0 }] : null,
    getPageIndex: async (ref: { num: number; gen: number }) => ref.num === 20 ? 5 : -1,
  }

  assert.equal(await outlineDestinationPage(doc, 'chapter'), 6)
  assert.equal(await outlineDestinationPage(doc, [{ num: 20, gen: 0 }]), 6)
  assert.equal(await outlineDestinationPage(doc, [2]), 3)
  assert.equal(await outlineDestinationPage(doc, [99]), undefined)
  assert.equal(await outlineDestinationPage(doc, null), undefined)
})
