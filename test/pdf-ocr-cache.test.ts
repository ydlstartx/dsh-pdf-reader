import assert from 'node:assert/strict'
import test from 'node:test'
import { pdfOcrCacheVictims } from '../src/client/pdf-ocr-client.ts'

test('OCR cache evicts least-recently-used pages by item count', () => {
  const metadata = [
    { key: 'old', updatedAt: 1, bytes: 10 },
    { key: 'middle', updatedAt: 2, bytes: 10 },
    { key: 'recent', updatedAt: 3, bytes: 10 },
  ]
  assert.deepEqual(pdfOcrCacheVictims(metadata, 2, 100), ['old'])
})

test('OCR cache also respects its persistent byte budget', () => {
  const metadata = [
    { key: 'old', updatedAt: 1, bytes: 60 },
    { key: 'recent', updatedAt: 2, bytes: 60 },
  ]
  assert.deepEqual(pdfOcrCacheVictims(metadata, 10, 80), ['old'])
  assert.deepEqual(pdfOcrCacheVictims(metadata, 10, 10), ['old', 'recent'])
})
