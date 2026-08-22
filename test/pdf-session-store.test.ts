import assert from 'node:assert/strict'
import test from 'node:test'
import {
  pdfSessionCacheVictims,
} from '../src/client/pdf-session-store.ts'
import type { PdfSessionMetadata } from '../src/client/pdf-session-store.ts'

function metadata(sessionId: string, updatedAt: number, bytes = 10): PdfSessionMetadata {
  return { sessionId, updatedAt, documentBytes: bytes, stateBytes: 0 }
}

test('PDF session cache evicts oldest conversations first', () => {
  const records = [
    metadata('oldest', 1),
    metadata('older', 2),
    metadata('current', 3),
    metadata('newest', 4),
  ]
  assert.deepEqual(pdfSessionCacheVictims(records, 'current', 2, 1_000), ['oldest', 'older'])
})

test('PDF session cache never evicts the conversation being saved', () => {
  const records = [
    metadata('current', 1, 80),
    metadata('other', 2, 40),
  ]
  assert.deepEqual(pdfSessionCacheVictims(records, 'current', 8, 50), ['other'])
})

test('PDF session cache accounts for document and view-state bytes', () => {
  const records: PdfSessionMetadata[] = [
    { sessionId: 'first', updatedAt: 1, documentBytes: 25, stateBytes: 15 },
    { sessionId: 'current', updatedAt: 2, documentBytes: 25, stateBytes: 15 },
  ]
  assert.deepEqual(pdfSessionCacheVictims(records, 'current', 8, 60), ['first'])
  assert.deepEqual(records.map(record => record.sessionId), ['first', 'current'])
})
