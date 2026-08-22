import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findPdfTextMatches,
  isBlankPdfSearchQuery,
  pdfPageText,
  pdfSearchHighlightSlices,
} from '../src/client/pdf-search.ts'

test('PDF search treats an emptied draft as blank', () => {
  assert.equal(isBlankPdfSearchQuery(''), true)
  assert.equal(isBlankPdfSearchQuery(' \n\t'), true)
  assert.equal(isBlankPdfSearchQuery(' kernel '), false)
})

test('PDF page text keeps text items and normalizes item whitespace', () => {
  assert.equal(pdfPageText([
    { str: 'Hello' },
    { type: 'beginMarkedContent', id: 'x' },
    { str: '   world\n' },
    { str: '中文' },
  ]), 'Hello world 中文')
})

test('PDF search ignores extraction whitespace and ASCII case', () => {
  const matches = findPdfTextMatches('Using Pyt hon 数据 模型 safely', 'python数据模型', 12, 10)

  assert.equal(matches.length, 1)
  assert.equal(matches[0]?.pageNumber, 12)
  assert.match(matches[0]?.snippet ?? '', /Pyt hon 数据 模型/)
})

test('PDF search returns non-overlapping hits within its caller bound', () => {
  const matches = findPdfTextMatches('aaaaa', 'aa', 3, 2)

  assert.deepEqual(matches.map(match => match.offset), [0, 2])
  assert.deepEqual(matches.map(match => match.endOffset), [2, 4])
  assert.equal(findPdfTextMatches('text', '   ', 1, 10).length, 0)
  assert.equal(findPdfTextMatches('text text', 'text', 1, 0).length, 0)
})

test('PDF search can resume after a bounded page batch without duplicate hits', () => {
  const text = 'hit hit hit hit hit'
  const first = findPdfTextMatches(text, 'hit', 1, 2)
  const second = findPdfTextMatches(text, 'hit', 1, 2, first.length)

  assert.deepEqual(first.map(match => match.offset), [0, 4])
  assert.deepEqual(second.map(match => match.offset), [8, 12])
})

test('clicked result maps back to its overlapping PDF text items', () => {
  const items = [{ str: 'Using' }, { str: 'Python' }, { str: 'data model' }]
  const match = findPdfTextMatches(pdfPageText(items), 'python data', 1, 1)[0]

  assert.ok(match)
  assert.deepEqual(pdfSearchHighlightSlices(items, match), [
    { itemIndex: 1, startRatio: 0, endRatio: 1 },
    { itemIndex: 2, startRatio: 0, endRatio: 4 / 10 },
  ])
})
