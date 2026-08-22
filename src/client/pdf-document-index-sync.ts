/** Same-origin browser-to-host synchronization for derived PDF text only. */

import { PDF_DOCUMENT_INDEX_ROUTE } from '../pdf-document-index.ts'
import type { PdfDocumentIndexRequest } from '../pdf-document-index.ts'

export async function syncPdfDocumentIndex(
  request: PdfDocumentIndexRequest,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(PDF_DOCUMENT_INDEX_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    credentials: 'same-origin',
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  })
  if (response.ok) return
  if (response.status === 404 || response.status === 405) {
    throw new Error('PDF 工具宿主尚未加载，请重启 DSH Web 服务后刷新页面')
  }
  let detail = ''
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string') detail = `：${body.error}`
  } catch {
    // A non-JSON reverse proxy response still has a useful HTTP status.
  }
  throw new Error(`无法同步当前 PDF 索引（HTTP ${String(response.status)}）${detail}`)
}

export function createPdfDocumentId(): string {
  return [...crypto.getRandomValues(new Uint32Array(4))]
    .map(value => value.toString(36).padStart(7, '0'))
    .join('')
}
