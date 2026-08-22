import {
  MAX_PDF_DOCUMENT_INDEX_CODE_UNITS,
  MAX_PDF_DOCUMENT_INDEX_PAGES_PER_BATCH,
} from '../pdf-document-index.ts'
import type { PdfDocumentIndexPage } from '../pdf-document-index.ts'
import { createPdfDocumentId, syncPdfDocumentIndex } from './pdf-document-index-sync.ts'
import { pdfPageText } from './pdf-search.ts'
import { loadPdfDocument } from './pdfjs.ts'

/** Rebuild a missing inactive-tab index without mounting another reader UI. */
export async function buildBackgroundPdfDocumentIndex(options: {
  bytes: ArrayBuffer
  sessionId: string
  documentId: string
  documentName: string
  signal: AbortSignal
  onIndexId: (indexId: string) => void
  /** The caller has a persistent source and permits pdf.js to transfer this buffer. */
  transferOwnership?: boolean
}): Promise<string> {
  const task = loadPdfDocument(options.transferOwnership === true ? options.bytes : options.bytes.slice(0))
  try {
    const doc = await task.promise
    const indexId = createPdfDocumentId()
    options.onIndexId(indexId)
    await syncPdfDocumentIndex({
      action: 'replace',
      sessionId: options.sessionId,
      documentId: options.documentId,
      indexId,
      documentName: options.documentName,
      totalPages: doc.numPages,
    }, options.signal)
    let indexedPages = 0
    let codeUnits = 0
    let truncated = false
    let batch: PdfDocumentIndexPage[] = []
    let batchUnits = 0
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return
      const pages = batch
      batch = []
      batchUnits = 0
      await syncPdfDocumentIndex({
        action: 'append',
        sessionId: options.sessionId,
        documentId: options.documentId,
        indexId,
        indexedPages,
        truncated,
        pages,
      }, options.signal)
    }
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const page = await doc.getPage(pageNumber)
      let content
      try {
        content = await page.getTextContent()
      } finally {
        page.cleanup()
      }
      let text = pdfPageText(content.items)
      if (text.length > 250_000) {
        text = text.slice(0, 250_000)
        truncated = true
      }
      const remaining = MAX_PDF_DOCUMENT_INDEX_CODE_UNITS - codeUnits
      if (text.length > remaining) {
        text = text.slice(0, Math.max(0, remaining))
        truncated = true
      }
      if (batch.length > 0 && (batch.length >= MAX_PDF_DOCUMENT_INDEX_PAGES_PER_BATCH || batchUnits + text.length > 220_000)) {
        await flush()
      }
      batch.push({ pageNumber, text })
      batchUnits += text.length
      codeUnits += text.length
      indexedPages = pageNumber
      if (codeUnits >= MAX_PDF_DOCUMENT_INDEX_CODE_UNITS) {
        if (pageNumber < doc.numPages) truncated = true
        break
      }
      if (pageNumber % MAX_PDF_DOCUMENT_INDEX_PAGES_PER_BATCH === 0) {
        await flush()
        await new Promise<void>(resolve => { window.setTimeout(resolve, 0) })
      }
    }
    await flush()
    await syncPdfDocumentIndex({
      action: 'complete',
      sessionId: options.sessionId,
      documentId: options.documentId,
      indexId,
      indexedPages,
      truncated,
    }, options.signal)
    return indexId
  } finally {
    await task.destroy()
  }
}
