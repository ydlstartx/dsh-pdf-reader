/** Shared, JSON-safe vocabulary for the current-PDF tool index. */

export const PDF_DOCUMENT_INDEX_ROUTE = '/plugins/dsh-pdf-reader/document-index'
export const PDF_DOCUMENT_CITATION_ORIGIN = 'https://dsh-pdf.invalid'
export const MAX_PDF_DOCUMENT_INDEX_CODE_UNITS = 4_000_000
export const MAX_PDF_DOCUMENT_INDEX_PAGES_PER_BATCH = 8
export const MAX_PDF_DOCUMENT_INDEX_REQUEST_BYTES = 1_200_000
/** Retain this many conversations, not merely this many individual PDF tabs. */
export const MAX_PDF_DOCUMENT_INDEX_SESSIONS = 8
/** Prevent one conversation with tiny files from creating unbounded host maps. */
export const MAX_PDF_DOCUMENT_INDEX_DOCUMENTS_PER_SESSION = 64
/** Preserve the previous worst-case text budget while allowing many small PDFs. */
export const MAX_PDF_DOCUMENT_INDEX_TOTAL_CODE_UNITS = (
  MAX_PDF_DOCUMENT_INDEX_CODE_UNITS * MAX_PDF_DOCUMENT_INDEX_SESSIONS
)
export const MAX_PDF_DOCUMENT_SEARCH_RESULTS = 20
export const MAX_PDF_DOCUMENT_READ_PAGES = 12
export const MAX_PDF_DOCUMENT_READ_CODE_UNITS = 80_000
export const MAX_PDF_DOCUMENT_OUTLINE_CODE_UNITS = 60_000

export interface PdfDocumentIndexPage {
  pageNumber: number
  text: string
}

export interface PdfDocumentIndexOutlineItem {
  title: string
  depth: number
  pageNumber?: number
}

export interface PdfDocumentIndexSnapshot {
  documentId: string
  documentName: string
  totalPages: number
  indexedPages: number
  complete: boolean
  truncated: boolean
  pages: ReadonlyMap<number, string>
  outline: readonly PdfDocumentIndexOutlineItem[]
  updatedAt: number
}

export type PdfDocumentIndexRequest =
  | {
    action: 'probe'
    sessionId: string
    documentId: string
    indexId: string
  }
  | {
    action: 'replace'
    sessionId: string
    documentId: string
    indexId: string
    documentName: string
    totalPages: number
  }
  | {
    action: 'append'
    sessionId: string
    documentId: string
    indexId: string
    indexedPages: number
    truncated: boolean
    pages: readonly PdfDocumentIndexPage[]
  }
  | {
    action: 'outline'
    sessionId: string
    documentId: string
    indexId: string
    outline: readonly PdfDocumentIndexOutlineItem[]
  }
  | {
    action: 'complete'
    sessionId: string
    documentId: string
    indexId: string
    indexedPages: number
    truncated: boolean
  }
  | {
    action: 'clear'
    sessionId: string
    documentId: string
    indexId: string
  }

export interface PdfDocumentSearchMatch {
  pageNumber: number
  offset: number
  endOffset: number
  snippet: string
}

function compactText(text: string): { compact: string; sourceOffsets: readonly number[] } {
  let compact = ''
  const sourceOffsets: number[] = []
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    const character = String.fromCodePoint(codePoint)
    if (!/\s/u.test(character)) {
      const folded = character.toLowerCase()
      compact += folded
      for (let foldedIndex = 0; foldedIndex < folded.length; foldedIndex += 1) sourceOffsets.push(index)
    }
    index += character.length
  }
  return { compact, sourceOffsets }
}

/** Search page text with the same whitespace-insensitive offsets used by the reader UI. */
export function searchPdfDocumentPages(
  pages: ReadonlyMap<number, string>,
  query: string,
  limit = MAX_PDF_DOCUMENT_SEARCH_RESULTS,
): readonly PdfDocumentSearchMatch[] {
  const normalizedQuery = compactText(query.trim()).compact
  const boundedLimit = Math.max(0, Math.min(MAX_PDF_DOCUMENT_SEARCH_RESULTS, Math.floor(limit)))
  if (normalizedQuery.length === 0 || boundedLimit === 0) return []
  const matches: PdfDocumentSearchMatch[] = []
  for (const [pageNumber, pageText] of [...pages].sort((left, right) => left[0] - right[0])) {
    const { compact, sourceOffsets } = compactText(pageText)
    let searchFrom = 0
    while (matches.length < boundedLimit) {
      const match = compact.indexOf(normalizedQuery, searchFrom)
      if (match < 0) break
      const sourceStart = sourceOffsets[match]
      const sourceEnd = sourceOffsets[match + normalizedQuery.length - 1]
      if (sourceStart === undefined || sourceEnd === undefined) break
      searchFrom = match + normalizedQuery.length
      const finalCodePoint = pageText.codePointAt(sourceEnd)
      const endOffset = Math.min(
        pageText.length,
        sourceEnd + (finalCodePoint !== undefined && finalCodePoint > 0xffff ? 2 : 1),
      )
      const snippetStart = Math.max(0, sourceStart - 80)
      const snippetEnd = Math.min(pageText.length, endOffset + 120)
      matches.push({
        pageNumber,
        offset: sourceStart,
        endOffset,
        snippet: `${snippetStart > 0 ? '…' : ''}${pageText.slice(snippetStart, snippetEnd)}${snippetEnd < pageText.length ? '…' : ''}`,
      })
    }
    if (matches.length >= boundedLimit) break
  }
  return matches
}

const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/u

export function validPdfDocumentId(value: string): boolean {
  return DOCUMENT_ID_PATTERN.test(value)
}

/** Safe HTTPS sentinel preserved by Markdown and intercepted by the reader. */
export function formatPdfDocumentCitationUrl(
  documentId: string,
  pageNumber: number,
  offset: number,
  endOffset: number,
): string {
  if (!validPdfDocumentId(documentId)) throw new Error('PDF 文档标识无效')
  for (const [name, value] of Object.entries({ pageNumber, offset, endOffset })) {
    if (!Number.isSafeInteger(value) || value < (name === 'pageNumber' ? 1 : 0)) {
      throw new Error(`PDF 来源位置 ${name} 无效`)
    }
  }
  if (endOffset < offset) throw new Error('PDF 来源结束位置无效')
  return `${PDF_DOCUMENT_CITATION_ORIGIN}/document/${documentId}/page/${String(pageNumber)}/${String(offset)}/${String(endOffset)}`
}
