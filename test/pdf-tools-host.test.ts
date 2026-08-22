import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import {
  PDF_DOCUMENT_INDEX_ROUTE,
  MAX_PDF_DOCUMENT_INDEX_DOCUMENTS_PER_SESSION,
  MAX_PDF_DOCUMENT_INDEX_SESSIONS,
  MAX_PDF_DOCUMENT_OUTLINE_CODE_UNITS,
  MAX_PDF_DOCUMENT_READ_CODE_UNITS,
} from '../src/pdf-document-index.ts'
import { PDF_OCR_ROUTE } from '../src/pdf-ocr.ts'

interface HostFixture {
  tools: Map<string, ToolDefinition>
  savedImages: Uint8Array[]
  request(body: unknown, origin?: string, path?: string): Promise<{ status: number; body: unknown }>
}

function hostFixture(): HostFixture {
  const tools = new Map<string, ToolDefinition>()
  type Handler = (req: unknown, res: unknown) => void | Promise<void>
  const handlers = new Map<string, Handler>()
  const savedImages: Uint8Array[] = []
  const attachments = {
    saveImage: async (input: { data: Uint8Array; mediaType: 'image/jpeg'; name?: string }) => {
      savedImages.push(Uint8Array.from(input.data))
      return {
        attachmentId: `image-${String(savedImages.length)}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 10,
        height: 10,
        ...(input.name === undefined ? {} : { name: input.name }),
      }
    },
  }
  const ctx = {
    effect: (setup: () => unknown) => setup(),
    get: (name: string) => name === 'attachments' ? attachments : undefined,
    webServer: {
      register: (route: { path: string; handler: Handler }) => {
        handlers.set(route.path, route.handler)
        return () => {}
      },
    },
    tools: {
      register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
  } as unknown as Context
  apply(ctx)

  return {
    tools,
    savedImages,
    async request(body, origin = 'http://127.0.0.1:3080', path = PDF_DOCUMENT_INDEX_ROUTE) {
      let status = 0
      let responseBody = ''
      const payload = Buffer.from(JSON.stringify(body))
      const req = {
        method: 'POST',
        headers: { origin, host: '127.0.0.1:3080' },
        async *[Symbol.asyncIterator]() { yield payload },
      }
      const res = {
        writeHead: (next: number) => { status = next },
        end: (next?: string) => { responseBody = next ?? '' },
      }
      const handler = handlers.get(path)
      assert.notEqual(handler, undefined)
      await handler!(req, res)
      return { status, body: JSON.parse(responseBody) as unknown }
    },
  }
}

function execution(sessionId: string): ToolRunContext {
  return {
    agent: { session: { id: sessionId } },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

test('host tools read only the PDF index bound to their calling session', async () => {
  const fixture = hostFixture()
  const documentId = '0abc1230def456'
  const indexId = 'index1230def456'
  assert.deepEqual([...fixture.tools.keys()].sort(), [
    'pdf_document_map', 'pdf_list_documents', 'pdf_ocr_pages', 'pdf_outline', 'pdf_read_pages', 'pdf_search',
  ])

  assert.equal((await fixture.request({
    action: 'replace', sessionId: 'session-a', documentId, indexId, documentName: 'GPU.pdf', totalPages: 3,
  })).status, 200)
  assert.equal((await fixture.request({
    action: 'append', sessionId: 'session-a', documentId, indexId, indexedPages: 3, truncated: false,
    pages: [
      { pageNumber: 1, text: 'Shared memory is on chip.' },
      { pageNumber: 2, text: 'Global memory has higher latency.' },
      { pageNumber: 3, text: 'Registers are private to a thread.' },
    ],
  })).status, 200)
  assert.equal((await fixture.request({
    action: 'outline', sessionId: 'session-a', documentId, indexId,
    outline: [{ title: 'Memory hierarchy', depth: 0, pageNumber: 1 }],
  })).status, 200)
  assert.equal((await fixture.request({
    action: 'complete', sessionId: 'session-a', documentId, indexId, indexedPages: 3, truncated: false,
  })).status, 200)

  const search = fixture.tools.get('pdf_search')!
  const searchValue = await search.execute({ document_id: documentId, query: 'shared memory', max_results: 4 }, execution('session-a')) as {
    matches: Array<{ pageNumber: number; source: string }>
  }
  assert.equal(searchValue.matches[0]?.pageNumber, 1)
  assert.match(searchValue.matches[0]?.source ?? '', /document\/0abc1230def456\/page\/1/)
  const rendered = search.output.render({}, searchValue).map(block => block.type === 'text' ? block.text : '').join('\n')
  assert.match(rendered, /\[GPU\.pdf｜第 1 页\]\(https:\/\/dsh-pdf\.invalid/)

  const read = await fixture.tools.get('pdf_read_pages')!.execute({ document_id: documentId, pages: [2] }, execution('session-a')) as {
    pages: Array<{ text: string }>
  }
  assert.equal(read.pages[0]?.text, 'Global memory has higher latency.')
  const outline = await fixture.tools.get('pdf_outline')!.execute({ document_id: documentId }, execution('session-a')) as {
    outline: Array<{ title: string; pageNumber?: number }>
  }
  assert.deepEqual(outline.outline, [{
    title: 'Memory hierarchy', depth: 0, pageNumber: 1,
    source: '[GPU.pdf｜第 1 页](https://dsh-pdf.invalid/document/0abc1230def456/page/1/0/0)',
  }])

  await assert.rejects(
    fixture.tools.get('pdf_search')!.execute({ document_id: documentId, query: 'memory' }, execution('session-b')),
    /指定 PDF 没有打开或尚未建立索引/,
  )
})

test('one conversation keeps PDF indexes isolated by document id', async () => {
  const fixture = hostFixture()
  const first = { documentId: 'firstdoc1234567', indexId: 'firstidx1234567' }
  const second = { documentId: 'seconddoc123456', indexId: 'secondidx123456' }
  for (const [document, text] of [[first, 'alpha only'], [second, 'beta only']] as const) {
    assert.equal((await fixture.request({
      action: 'replace', sessionId: 'session-tabs', ...document,
      documentName: `${document.documentId}.pdf`, totalPages: 1,
    })).status, 200)
    assert.equal((await fixture.request({
      action: 'append', sessionId: 'session-tabs', ...document,
      indexedPages: 1, truncated: false, pages: [{ pageNumber: 1, text }],
    })).status, 200)
  }

  const list = await fixture.tools.get('pdf_list_documents')!.execute({}, execution('session-tabs')) as {
    documents: Array<{ documentId: string }>
  }
  assert.deepEqual(new Set(list.documents.map(document => document.documentId)), new Set([first.documentId, second.documentId]))
  const firstRead = await fixture.tools.get('pdf_read_pages')!.execute({
    document_id: first.documentId,
    pages: [1],
  }, execution('session-tabs')) as { pages: Array<{ text: string }> }
  const secondRead = await fixture.tools.get('pdf_read_pages')!.execute({
    document_id: second.documentId,
    pages: [1],
  }, execution('session-tabs')) as { pages: Array<{ text: string }> }
  assert.equal(firstRead.pages[0]?.text, 'alpha only')
  assert.equal(secondRead.pages[0]?.text, 'beta only')
})

test('document index retention is bounded by conversations instead of PDF tabs', async () => {
  const fixture = hostFixture()
  const sessionId = 'session-many-tabs'
  const documents = Array.from({ length: MAX_PDF_DOCUMENT_INDEX_SESSIONS + 1 }, (_, index) => ({
    documentId: `manytabdoc${String(index).padStart(8, '0')}`,
    indexId: `manytabidx${String(index).padStart(8, '0')}`,
  }))
  for (const [index, document] of documents.entries()) {
    assert.equal((await fixture.request({
      action: 'replace', sessionId, ...document,
      documentName: `tab-${String(index + 1)}.pdf`, totalPages: 1,
    })).status, 200)
    assert.equal((await fixture.request({
      action: 'append', sessionId, ...document,
      indexedPages: 1, truncated: false, pages: [{ pageNumber: 1, text: `tab ${String(index + 1)}` }],
    })).status, 200)
  }

  const list = await fixture.tools.get('pdf_list_documents')!.execute({}, execution(sessionId)) as {
    documents: Array<{ documentId: string }>
  }
  assert.equal(list.documents.length, documents.length)
  const first = await fixture.tools.get('pdf_read_pages')!.execute({
    document_id: documents[0]!.documentId,
    pages: [1],
  }, execution(sessionId)) as { pages: Array<{ text: string }> }
  assert.equal(first.pages[0]?.text, 'tab 1')
})

test('oldest conversation indexes are evicted as one group', async () => {
  const fixture = hostFixture()
  const sessions = Array.from({ length: MAX_PDF_DOCUMENT_INDEX_SESSIONS + 1 }, (_, index) => ({
    sessionId: `session-${String(index).padStart(3, '0')}`,
    documentId: `sessiondoc${String(index).padStart(8, '0')}`,
    indexId: `sessionidx${String(index).padStart(8, '0')}`,
  }))
  for (const item of sessions) {
    assert.equal((await fixture.request({
      action: 'replace', ...item, documentName: `${item.sessionId}.pdf`, totalPages: 1,
    })).status, 200)
  }

  await assert.rejects(
    fixture.tools.get('pdf_read_pages')!.execute({
      document_id: sessions[0]!.documentId,
      pages: [1],
    }, execution(sessions[0]!.sessionId)),
    /指定 PDF 没有打开或尚未建立索引/,
  )
  const newest = await fixture.tools.get('pdf_list_documents')!.execute({}, execution(sessions.at(-1)!.sessionId)) as {
    documents: Array<{ documentId: string }>
  }
  assert.equal(newest.documents[0]?.documentId, sessions.at(-1)!.documentId)
})

test('one conversation cannot grow an unbounded number of document indexes', async () => {
  const fixture = hostFixture()
  const sessionId = 'session-document-limit'
  for (let index = 0; index < MAX_PDF_DOCUMENT_INDEX_DOCUMENTS_PER_SESSION; index += 1) {
    const suffix = String(index).padStart(8, '0')
    assert.equal((await fixture.request({
      action: 'replace', sessionId,
      documentId: `limitdoc${suffix}`,
      indexId: `limitidx${suffix}`,
      documentName: `${suffix}.pdf`, totalPages: 1,
    })).status, 200)
  }
  const overflow = await fixture.request({
    action: 'replace', sessionId,
    documentId: 'limitdocoverflow',
    indexId: 'limitidxoverflow',
    documentName: 'overflow.pdf', totalPages: 1,
  })
  assert.equal(overflow.status, 400)
  assert.match(String((overflow.body as { error?: unknown }).error), /一个会话最多建立/)
})

test('selected documents share one OCR and visual budget', async () => {
  const fixture = hostFixture()
  const sessionId = 'session-shared-ocr'
  const grantId = 'sharedgrant12345'
  const first = { documentId: 'sharedfirst1234', indexId: 'sharedfirstidx1' }
  const second = { documentId: 'sharedsecond123', indexId: 'sharedsecondidx' }
  for (const document of [first, second]) {
    assert.equal((await fixture.request({
      action: 'replace', sessionId, ...document,
      documentName: `${document.documentId}.pdf`, totalPages: 2,
    })).status, 200)
    assert.equal((await fixture.request({
      action: 'grant', sessionId, ...document, grantId,
      currentPage: 1, maxOcrPages: 1, maxVisualPages: 1, maxPagesPerBatch: 1,
    }, undefined, PDF_OCR_ROUTE)).status, 200)
  }

  const pending = fixture.tools.get('pdf_ocr_pages')!.execute({
    document_id: first.documentId,
    grant_id: grantId,
    pages: [1],
    visual_pages: [1],
    reason: '第一份文档中的关键证据',
  }, execution(sessionId)) as Promise<{ remainingOcrPages: number; remainingVisualPages: number }>
  const poll = (await fixture.request({
    action: 'poll', sessionId, ...first,
  }, undefined, PDF_OCR_ROUTE)).body as { requestId: string }
  assert.equal((await fixture.request({
    action: 'result', sessionId, ...first, requestId: poll.requestId, grantId,
    pageNumber: 1, width: 100, height: 100, durationMs: 1, fromCache: false,
    jpegBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
    lines: [{
      text: 'first evidence', score: 1,
      polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    }],
  }, undefined, PDF_OCR_ROUTE)).status, 200)
  const firstValue = await pending as {
    documentName: string
    remainingOcrPages: number
    remainingVisualPages: number
    pages: unknown[]
  }
  assert.equal(firstValue.documentName, `${first.documentId}.pdf`)
  assert.equal(firstValue.remainingOcrPages, 0)
  assert.equal(firstValue.remainingVisualPages, 0)
  assert.equal(firstValue.pages.length, 1)

  await assert.rejects(
    fixture.tools.get('pdf_ocr_pages')!.execute({
      document_id: second.documentId,
      grant_id: grantId,
      pages: [1],
      reason: '第二份文档也需要 OCR',
    }, execution(sessionId)),
    /OCR 授权余额不足.*还可新增 0 页/,
  )
  const secondMap = await fixture.tools.get('pdf_document_map')!.execute({
    document_id: second.documentId,
  }, execution(sessionId)) as { grant: { remainingOcrPages: number; remainingVisualPages: number } }
  assert.equal(secondMap.grant.remainingOcrPages, 0)
  assert.equal(secondMap.grant.remainingVisualPages, 0)
})

test('on-demand OCR requires a bounded grant and lets the model choose one small page batch', async () => {
  const fixture = hostFixture()
  const documentId = 'ocrdoc12345678'
  const indexId = 'ocrindex123456'
  const grantId = 'ocrgrant123456'
  assert.equal((await fixture.request({
    action: 'replace', sessionId: 'session-ocr', documentId, indexId,
    documentName: 'Scanned.pdf', totalPages: 1_248,
  })).status, 200)

  await assert.rejects(
    fixture.tools.get('pdf_ocr_pages')!.execute({
      document_id: documentId, grant_id: grantId, pages: [601], reason: '当前页最可能相关',
    }, execution('session-ocr')),
    /没有有效的 PDF OCR 授权/,
  )

  assert.equal((await fixture.request({
    action: 'grant', sessionId: 'session-ocr', documentId, indexId, grantId,
    currentPage: 601, maxOcrPages: 500, maxVisualPages: 25, maxPagesPerBatch: 40,
  }, undefined, PDF_OCR_ROUTE)).status, 200)

  const map = await fixture.tools.get('pdf_document_map')!.execute({ document_id: documentId }, execution('session-ocr')) as {
    totalPages: number
    grant: { currentPage: number; remainingOcrPages: number }
  }
  assert.equal(map.totalPages, 1_248)
  assert.deepEqual(map.grant, {
    currentPage: 601,
    remainingOcrPages: 500,
    remainingVisualPages: 25,
    maxPagesPerBatch: 40,
  })
  await assert.rejects(
    fixture.tools.get('pdf_ocr_pages')!.execute({
      document_id: documentId,
      grant_id: grantId,
      pages: Array.from({ length: 41 }, (_, index) => index + 1),
      reason: '超过用户配置的单批上限',
    }, execution('session-ocr')),
    /本次授权的单批上限/,
  )

  const pending = fixture.tools.get('pdf_ocr_pages')!.execute({
    document_id: documentId,
    grant_id: grantId,
    pages: [601, 1],
    visual_pages: [601],
    reason: '先检查当前页和封面，建立问题上下文',
  }, execution('session-ocr')) as Promise<{
    remainingOcrPages: number
    remainingVisualPages: number
    pages: Array<{ pageNumber: number; image?: { attachmentId: string } }>
  }>
  const poll = await fixture.request({
    action: 'poll', sessionId: 'session-ocr', documentId, indexId,
  }, undefined, PDF_OCR_ROUTE)
  assert.equal(poll.status, 200)
  const request = poll.body as { requestId: string; grantId: string; pages: number[]; visualPages: number[] }
  assert.deepEqual(request.pages, [601, 1])
  assert.deepEqual(request.visualPages, [601])

  const line = {
    text: 'Shared memory is on chip.',
    score: 0.95,
    polygon: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.2 }, { x: 0.1, y: 0.2 }],
  }
  assert.equal((await fixture.request({
    action: 'result', sessionId: 'session-ocr', documentId, indexId,
    requestId: request.requestId, grantId, pageNumber: 601,
    width: 1000, height: 1400, durationMs: 100, fromCache: false, lines: [line],
    jpegBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
  }, undefined, PDF_OCR_ROUTE)).status, 200)
  assert.equal((await fixture.request({
    action: 'result', sessionId: 'session-ocr', documentId, indexId,
    requestId: request.requestId, grantId, pageNumber: 1,
    width: 1000, height: 1400, durationMs: 100, fromCache: false, lines: [{ ...line, text: 'Cover' }],
  }, undefined, PDF_OCR_ROUTE)).status, 200)

  const value = await pending
  assert.equal(value.remainingOcrPages, 498)
  assert.equal(value.remainingVisualPages, 24)
  assert.deepEqual(value.pages.map(page => page.pageNumber), [601, 1])
  assert.equal(value.pages[0]?.image?.attachmentId, 'image-1')
  assert.equal(fixture.savedImages.length, 1)
  const rendered = fixture.tools.get('pdf_ocr_pages')!.output.render({}, value)
  assert.ok(rendered.some(block => block.type === 'image'))
  assert.ok(rendered.some(block => block.type === 'text' && block.text.includes('第 601 页')))
})

test('cached OCR pages do not consume a new-page grant budget', async () => {
  const fixture = hostFixture()
  const documentId = 'cachedocr123456'
  const indexId = 'cachedindex1234'
  const grantId = 'cachedgrant1234'
  const base = { sessionId: 'session-cache', documentId, indexId }
  assert.equal((await fixture.request({
    action: 'replace', ...base, documentName: 'Cached.pdf', totalPages: 20,
  })).status, 200)
  assert.equal((await fixture.request({
    action: 'cache-manifest', ...base, pages: [7],
  }, undefined, PDF_OCR_ROUTE)).status, 200)
  assert.equal((await fixture.request({
    action: 'grant', ...base, grantId, currentPage: 7, maxOcrPages: 1, maxVisualPages: 0, maxPagesPerBatch: 4,
  }, undefined, PDF_OCR_ROUTE)).status, 200)

  const pending = fixture.tools.get('pdf_ocr_pages')!.execute({
    document_id: documentId, grant_id: grantId, pages: [7], reason: '复用已有结果',
  }, execution('session-cache')) as Promise<{ remainingOcrPages: number }>
  const poll = (await fixture.request({ action: 'poll', ...base }, undefined, PDF_OCR_ROUTE)).body as {
    requestId: string
  }
  assert.equal((await fixture.request({
    action: 'result', ...base, requestId: poll.requestId, grantId, pageNumber: 7,
    width: 100, height: 100, durationMs: 0, fromCache: true,
    lines: [{
      text: 'cached', score: 1,
      polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    }],
  }, undefined, PDF_OCR_ROUTE)).status, 200)
  assert.equal((await pending).remainingOcrPages, 1)
})

test('a cache miss discovered after the manifest still consumes OCR budget', async () => {
  const fixture = hostFixture()
  const base = {
    sessionId: 'session-cache-miss',
    documentId: 'cachemissdoc1234',
    indexId: 'cachemissindex12',
  }
  const grantId = 'cachemissgrant12'
  assert.equal((await fixture.request({
    action: 'replace', ...base, documentName: 'Cache miss.pdf', totalPages: 20,
  })).status, 200)
  assert.equal((await fixture.request({
    action: 'cache-manifest', ...base, pages: [7],
  }, undefined, PDF_OCR_ROUTE)).status, 200)
  assert.equal((await fixture.request({
    action: 'grant', ...base, grantId, currentPage: 7, maxOcrPages: 1, maxVisualPages: 0, maxPagesPerBatch: 4,
  }, undefined, PDF_OCR_ROUTE)).status, 200)

  const pending = fixture.tools.get('pdf_ocr_pages')!.execute({
    document_id: base.documentId, grant_id: grantId, pages: [7], reason: '尝试读取已公布的缓存页',
  }, execution(base.sessionId)) as Promise<{ remainingOcrPages: number }>
  const poll = (await fixture.request({ action: 'poll', ...base }, undefined, PDF_OCR_ROUTE)).body as {
    requestId: string
  }
  assert.equal((await fixture.request({
    action: 'result', ...base, requestId: poll.requestId, grantId, pageNumber: 7,
    width: 100, height: 100, durationMs: 25, fromCache: false,
    lines: [{
      text: 'fresh result', score: 1,
      polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    }],
  }, undefined, PDF_OCR_ROUTE)).status, 200)
  assert.equal((await pending).remainingOcrPages, 0)
})

test('host index route rejects cross-origin writes and stale batches stay inert', async () => {
  const fixture = hostFixture()
  const documentId = '0abc1230def456'
  const indexId = 'index1230def456'
  const nextIndexId = 'index7890new123'
  assert.equal((await fixture.request({
    action: 'replace', sessionId: 'session-a', documentId, indexId, documentName: 'GPU.pdf', totalPages: 1,
  }, 'http://example.test')).status, 403)

  assert.equal((await fixture.request({
    action: 'clear', sessionId: 'session-a', documentId, indexId,
  })).status, 200)
  assert.equal((await fixture.request({
    action: 'probe', sessionId: 'session-a', documentId, indexId,
  })).status, 400)
  assert.equal((await fixture.request({
    action: 'append', sessionId: 'session-a', documentId, indexId, indexedPages: 1, truncated: false,
    pages: [{ pageNumber: 1, text: 'must not resurrect' }],
  })).status, 200)
  await assert.rejects(
    fixture.tools.get('pdf_read_pages')!.execute({ document_id: documentId, pages: [1] }, execution('session-a')),
    /指定 PDF 没有打开或尚未建立索引/,
  )

  assert.equal((await fixture.request({
    action: 'replace', sessionId: 'session-a', documentId, indexId: nextIndexId,
    documentName: 'Current.pdf', totalPages: 1,
  })).status, 200)
  assert.equal((await fixture.request({
    action: 'append', sessionId: 'session-a', documentId, indexId: nextIndexId,
    indexedPages: 1, truncated: false, pages: [{ pageNumber: 1, text: 'current index' }],
  })).status, 200)
  assert.equal((await fixture.request({
    action: 'probe', sessionId: 'session-a', documentId, indexId: nextIndexId,
  })).status, 200)
  // A delayed replace for the already-cleared instance is accepted as a no-op.
  assert.equal((await fixture.request({
    action: 'replace', sessionId: 'session-a', documentId, indexId,
    documentName: 'Stale.pdf', totalPages: 1,
  })).status, 200)
  const current = await fixture.tools.get('pdf_read_pages')!.execute({ document_id: documentId, pages: [1] }, execution('session-a')) as {
    documentName: string
    pages: Array<{ text: string }>
  }
  assert.equal(current.documentName, 'Current.pdf')
  assert.equal(current.pages[0]?.text, 'current index')
})

test('host tools bound page and outline output before it enters the model context', async () => {
  const fixture = hostFixture()
  const documentId = '0abc1230def456'
  const indexId = 'index1230def456'
  assert.equal((await fixture.request({
    action: 'replace', sessionId: 'session-a', documentId, indexId, documentName: 'Large.pdf', totalPages: 1,
  })).status, 200)
  assert.equal((await fixture.request({
    action: 'append', sessionId: 'session-a', documentId, indexId, indexedPages: 1, truncated: false,
    pages: [{ pageNumber: 1, text: 'x'.repeat(MAX_PDF_DOCUMENT_READ_CODE_UNITS + 1) }],
  })).status, 200)
  await assert.rejects(
    fixture.tools.get('pdf_read_pages')!.execute({ document_id: documentId, pages: [1] }, execution('session-a')),
    /请减少页数/,
  )

  const title = 't'.repeat(500)
  const outlineItems = Array.from({ length: Math.floor(MAX_PDF_DOCUMENT_OUTLINE_CODE_UNITS / title.length) + 1 }, () => ({
    title,
    depth: 0,
    pageNumber: 1,
  }))
  assert.equal((await fixture.request({
    action: 'outline', sessionId: 'session-a', documentId, indexId, outline: outlineItems,
  })).status, 200)
  const outline = await fixture.tools.get('pdf_outline')!.execute({ document_id: documentId }, execution('session-a')) as {
    outlineTruncated: boolean
    outline: Array<{ title: string }>
  }
  assert.equal(outline.outlineTruncated, true)
  assert.equal(outline.outline.length, Math.floor(MAX_PDF_DOCUMENT_OUTLINE_CODE_UNITS / title.length))
})
