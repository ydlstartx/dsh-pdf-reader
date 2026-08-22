import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatPdfDocumentCitationUrl,
  searchPdfDocumentPages,
  validPdfDocumentId,
} from '../src/pdf-document-index.ts'

test('whole-PDF search ignores item whitespace while preserving source offsets', () => {
  const pages = new Map([
    [1, 'The shared memory path is fast.'],
    [2, 'Global memory is slower; sharedmemory remains on chip.'],
  ])
  const matches = searchPdfDocumentPages(pages, 'shared memory', 5)
  assert.equal(matches.length, 2)
  assert.deepEqual(matches.map(match => match.pageNumber), [1, 2])
  assert.equal(pages.get(1)?.slice(matches[0]!.offset, matches[0]!.endOffset), 'shared memory')
  assert.equal(pages.get(2)?.slice(matches[1]!.offset, matches[1]!.endOffset), 'sharedmemory')
})

test('whole-PDF search is bounded and ordered by page', () => {
  const pages = new Map([[3, 'CUDA CUDA'], [1, 'CUDA CUDA'], [2, 'CUDA']])
  assert.deepEqual(
    searchPdfDocumentPages(pages, 'cuda', 3).map(match => match.pageNumber),
    [1, 1, 2],
  )
  assert.deepEqual(searchPdfDocumentPages(pages, '   ', 3), [])
})

test('document citation URLs encode only bounded source positions', () => {
  const documentId = '0abc1230def456'
  assert.equal(validPdfDocumentId(documentId), true)
  assert.equal(
    formatPdfDocumentCitationUrl(documentId, 7, 12, 28),
    'https://dsh-pdf.invalid/document/0abc1230def456/page/7/12/28',
  )
  assert.throws(() => formatPdfDocumentCitationUrl('../bad', 1, 0, 1), /文档标识无效/)
  assert.throws(() => formatPdfDocumentCitationUrl(documentId, 0, 0, 1), /pageNumber 无效/)
  assert.throws(() => formatPdfDocumentCitationUrl(documentId, 1, 5, 4), /结束位置无效/)
})
