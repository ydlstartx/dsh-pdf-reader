import type { PdfTextEvidence } from './pdf-evidence.ts'
import type { NormalizedPdfRect, PdfPageRotation } from './pdf-rotation.ts'
import { PDF_DOCUMENT_CITATION_ORIGIN, validPdfDocumentId } from '../pdf-document-index.ts'

export const PDF_CITATION_ORIGIN = 'https://dsh-pdf.invalid'
export const MAX_PDF_CITATION_BATCHES = 24

export type PdfCitationKind = 'image' | 'text'

export interface PdfBatchCitationReference {
  batchId: string
  kind: PdfCitationKind
  /** Zero-based source index inside the submitted batch. */
  index: number
}

export interface PdfDocumentCitationReference {
  kind: 'document'
  documentId: string
  pageNumber: number
  offset: number
  endOffset: number
}

export type PdfCitationReference = PdfBatchCitationReference | PdfDocumentCitationReference

export interface PdfCitationImageTarget {
  documentId?: string
  documentName?: string
  pageNumber: number
  rect: NormalizedPdfRect
  rotation: PdfPageRotation
}

export interface PdfCitationBatch {
  id: string
  documentName: string
  images: readonly PdfCitationImageTarget[]
  texts: readonly PdfTextEvidence[]
}

export type PdfCitationTarget =
  | { kind: 'image'; source: PdfCitationImageTarget }
  | { kind: 'text'; source: PdfTextEvidence }
  | { kind: 'document'; source: PdfDocumentCitationReference }

const CITATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/u
const CITATION_LABEL_PATTERN = /\[(图|文)\s*([1-9]\d*)\]/gu
const CITATION_URL_PATTERN = /https:\/\/dsh-pdf\.invalid\/source\/[A-Za-z0-9_-]{1,80}\/(?:image|text)\/[1-9]\d*/gu

function assertCitationId(batchId: string): void {
  if (!CITATION_ID_PATTERN.test(batchId)) throw new Error('PDF 引用批次标识无效')
}

/** Safe HTTPS sentinel accepted by Harness Markdown and intercepted locally. */
export function formatPdfCitationUrl(batchId: string, kind: PdfCitationKind, index: number): string {
  assertCitationId(batchId)
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('PDF 引用序号无效')
  return `${PDF_CITATION_ORIGIN}/source/${batchId}/${kind}/${String(index + 1)}`
}

/** Parse only this plugin's exact sentinel URL; every other link remains host-owned. */
export function parsePdfCitationUrl(value: string): PdfCitationReference | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if ((url.origin !== PDF_CITATION_ORIGIN && url.origin !== PDF_DOCUMENT_CITATION_ORIGIN)
    || url.search.length > 0 || url.hash.length > 0) return undefined
  const document = /^\/document\/([A-Za-z0-9_-]{8,80})\/page\/([1-9]\d*)\/(\d+)\/(\d+)$/u.exec(url.pathname)
  if (document !== null) {
    const pageNumber = Number(document[2])
    const offset = Number(document[3])
    const endOffset = Number(document[4])
    if (!validPdfDocumentId(document[1]!)
      || !Number.isSafeInteger(pageNumber)
      || !Number.isSafeInteger(offset)
      || !Number.isSafeInteger(endOffset)
      || endOffset < offset) return undefined
    return { kind: 'document', documentId: document[1]!, pageNumber, offset, endOffset }
  }
  const match = /^\/source\/([A-Za-z0-9_-]{1,80})\/(image|text)\/([1-9]\d*)$/u.exec(url.pathname)
  if (match === null) return undefined
  const oneBasedIndex = Number(match[3])
  if (!Number.isSafeInteger(oneBasedIndex)) return undefined
  return { batchId: match[1]!, kind: match[2] as PdfCitationKind, index: oneBasedIndex - 1 }
}

/**
 * Recover the one citation batch embedded in a PDF mixed-reading prompt.
 * Ambiguous or unrelated prose deliberately returns undefined.
 */
export function parsePdfCitationBatchId(value: string): string | undefined {
  const batchIds = new Set<string>()
  for (const match of value.matchAll(CITATION_URL_PATTERN)) {
    const reference = parsePdfCitationUrl(match[0])
    if (reference !== undefined && reference.kind !== 'document') batchIds.add(reference.batchId)
    if (batchIds.size > 1) return undefined
  }
  return batchIds.values().next().value
}

/**
 * Resolve a model-emitted plain `[图 N]` / `[文 N]` at one caret offset.
 * Models frequently preserve the label but omit its authored Markdown URL.
 */
export function parsePdfCitationLabelAt(
  value: string,
  offset: number,
  batchId: string,
): PdfCitationReference | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length) return undefined
  if (!CITATION_ID_PATTERN.test(batchId)) return undefined
  for (const match of value.matchAll(CITATION_LABEL_PATTERN)) {
    const start = match.index
    const end = start + match[0].length
    if (offset < start || offset > end) continue
    const oneBasedIndex = Number(match[2])
    if (!Number.isSafeInteger(oneBasedIndex)) return undefined
    return {
      batchId,
      kind: match[1] === '图' ? 'image' : 'text',
      index: oneBasedIndex - 1,
    }
  }
  return undefined
}

/** Retain recent geometry without keeping screenshot PNG payloads indefinitely. */
export function appendPdfCitationBatch(
  current: readonly PdfCitationBatch[],
  batch: PdfCitationBatch,
): readonly PdfCitationBatch[] {
  assertCitationId(batch.id)
  const withoutSameId = current.filter(candidate => candidate.id !== batch.id)
  return [...withoutSameId, batch].slice(-MAX_PDF_CITATION_BATCHES)
}

export function resolvePdfCitation(
  batches: readonly PdfCitationBatch[],
  reference: PdfCitationReference,
): PdfCitationTarget | undefined {
  if (reference.kind === 'document') return { kind: 'document', source: reference }
  const batch = batches.find(candidate => candidate.id === reference.batchId)
  if (batch === undefined) return undefined
  if (reference.kind === 'image') {
    const source = batch.images[reference.index]
    return source === undefined ? undefined : { kind: 'image', source }
  }
  const source = batch.texts[reference.index]
  return source === undefined ? undefined : { kind: 'text', source }
}
