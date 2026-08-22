import assert from 'node:assert/strict'
import test from 'node:test'
import { syncPdfDocumentIndex } from '../src/client/pdf-document-index-sync.ts'

test('missing host route explains that DSH Web must be restarted', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 405 })
  try {
    await assert.rejects(syncPdfDocumentIndex({
      action: 'clear',
      sessionId: 'session-a',
      documentId: 'document123456',
      indexId: 'index12345678',
    }), /请重启 DSH Web 服务后刷新页面/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
