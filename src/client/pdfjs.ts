/**
 * pdf.js access point for the reader. The worker source ships inlined in
 * this bundle (see tsdown.config.ts) and becomes a blob URL on first use.
 * pdf.js creates one module worker per document from that URL, so destroying
 * an old loading task cannot terminate a replacement document's worker. No
 * external asset URL or import.meta is required by the classic plugin bundle.
 * @module dsh-pdf-reader/client/pdfjs
 */

import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist'
import binaryData from 'virtual:pdfjs-binary-data'
import workerSource from 'virtual:pdfjs-worker'

let workerSourceReady = false
const decodedBinaryData = new Map<string, Uint8Array>()

/** Main-thread resource provider used because a blob worker has no asset base URL. */
class InlineBinaryDataFactory {
  async fetch(request: { kind: string; filename: string }): Promise<Uint8Array> {
    const key = `${request.kind}:${request.filename}`
    let decoded = decodedBinaryData.get(key)
    if (decoded === undefined) {
      const encoded = binaryData[key]
      if (encoded === undefined) throw new Error(`缺少 PDF.js 内置资源: ${request.filename}`)
      const raw = atob(encoded)
      decoded = new Uint8Array(raw.length)
      for (let index = 0; index < raw.length; index += 1) decoded[index] = raw.charCodeAt(index)
      decodedBinaryData.set(key, decoded)
    }
    // pdf.js may transfer the returned buffer to its worker; retain an intact
    // cached copy for other pages and replacement documents.
    return decoded.slice()
  }
}

/** Install the inlined worker source exactly once per module lifetime. */
export function ensurePdfWorker(): void {
  if (workerSourceReady) return
  workerSourceReady = true
  const blob = new Blob([workerSource], { type: 'text/javascript' })
  // Older hot-reloaded revisions may have installed one shared native Worker.
  // Clear it explicitly: LoadingTask.destroy() owns and terminates its worker.
  GlobalWorkerOptions.workerPort = null
  GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob)
}

/** Load one document with every pdf.js runtime dependency available offline. */
export function loadPdfDocument(data: ArrayBuffer) {
  ensurePdfWorker()
  return getDocument({
    data,
    BinaryDataFactory: InlineBinaryDataFactory,
    cMapUrl: 'inline-pdfjs-cmaps/',
    standardFontDataUrl: 'inline-pdfjs-fonts/',
    wasmUrl: 'inline-pdfjs-wasm/',
    useWorkerFetch: false,
  })
}

export { TextLayer }
export type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
