/** One text-search hit. Exact canvas coordinates are intentionally absent. */
export interface PdfSearchResult {
  pageNumber: number
  /** Stable within one normalized page; used only as a React key. */
  offset: number
  /** Exclusive source-text end, used to locate the clicked occurrence. */
  endOffset: number
  snippet: string
}

export type PdfSearchStatus = 'idle' | 'running' | 'paused' | 'done' | 'cancelled' | 'error'

export interface PdfSearchState {
  query: string
  status: PdfSearchStatus
  results: readonly PdfSearchResult[]
  scannedPages: number
  totalPages: number
  hasSearchableText: boolean
  truncated: boolean
  failedPages: number
  error: string | undefined
}

export interface PdfSearchController {
  state: PdfSearchState
  run: (query: string) => void
  clear: () => void
  loadMore: () => void
  cancel: () => void
  navigate: (result: PdfSearchResult) => void
  clearHighlight: () => void
}

/** UI and worker bounds for a user-triggered, in-browser scan. */
export const MAX_PDF_SEARCH_QUERY_LENGTH = 100
/** One lazy result batch. Scanning pauses here until the user nears the end. */
export const MAX_PDF_SEARCH_RESULTS = 200
/** Keep the result DOM and retained snippets bounded across lazy batches. */
export const MAX_PDF_SEARCH_TOTAL_RESULTS = 2_000
export const PDF_SEARCH_CONCURRENCY = 4
/** At most about 8 MiB of UTF-16 page text, excluding JS object overhead. */
export const MAX_PDF_SEARCH_CACHE_CODE_UNITS = 4_000_000

/** Whether a search draft contains no searchable characters. */
export function isBlankPdfSearchQuery(query: string): boolean {
  return !/\S/u.test(query)
}

interface TextItemLike {
  str: string
}

export interface PdfTextRun {
  itemIndex: number
  start: number
  end: number
}

export interface PdfPageTextLayout {
  text: string
  runs: readonly PdfTextRun[]
}

export interface PdfSearchHighlightSlice {
  itemIndex: number
  startRatio: number
  endRatio: number
}

function isTextItemLike(value: unknown): value is TextItemLike {
  return typeof value === 'object' && value !== null
    && typeof (value as Partial<TextItemLike>).str === 'string'
}

/** Convert pdf.js items into readable text while retaining item source ranges. */
export function pdfPageTextLayout(items: readonly unknown[]): PdfPageTextLayout {
  let text = ''
  const runs: PdfTextRun[] = []
  items.forEach((item, itemIndex) => {
    if (!isTextItemLike(item)) return
    const normalized = item.str.replace(/\s+/gu, ' ').trim()
    if (normalized.length === 0) return
    if (text.length > 0) text += ' '
    const start = text.length
    text += normalized
    runs.push({ itemIndex, start, end: text.length })
  })
  return { text, runs }
}

/** Convert pdf.js text-content items into readable, whitespace-normalized text. */
export function pdfPageText(items: readonly unknown[]): string {
  return pdfPageTextLayout(items).text
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
      // Some Unicode case folds expand to multiple UTF-16 code units. Keep a
      // source offset for each so snippet lookup remains total and bounded.
      for (let foldedIndex = 0; foldedIndex < folded.length; foldedIndex += 1) sourceOffsets.push(index)
    }
    index += character.length
  }
  return { compact, sourceOffsets }
}

/**
 * Find bounded, non-overlapping hits while ignoring PDF item whitespace.
 * Ignoring whitespace lets a Chinese phrase span separate glyph runs and an
 * English phrase span separate word items without building a text layer.
 */
export function findPdfTextMatches(
  pageText: string,
  query: string,
  pageNumber: number,
  limit: number,
  skip = 0,
): readonly PdfSearchResult[] {
  const boundedLimit = Math.max(0, Math.floor(limit))
  const boundedSkip = Math.max(0, Math.floor(skip))
  const normalizedQuery = compactText(query.trim()).compact
  if (boundedLimit === 0 || normalizedQuery.length === 0 || pageText.length === 0) return []
  const { compact, sourceOffsets } = compactText(pageText)
  const results: PdfSearchResult[] = []
  let searchFrom = 0
  let skipped = 0
  while (results.length < boundedLimit) {
    const match = compact.indexOf(normalizedQuery, searchFrom)
    if (match < 0) break
    const sourceStart = sourceOffsets[match]
    const sourceEnd = sourceOffsets[match + normalizedQuery.length - 1]
    if (sourceStart === undefined || sourceEnd === undefined) break
    searchFrom = match + normalizedQuery.length
    if (skipped < boundedSkip) {
      skipped += 1
      continue
    }
    const snippetStart = Math.max(0, sourceStart - 48)
    const finalCodePoint = pageText.codePointAt(sourceEnd)
    const endOffset = Math.min(pageText.length, sourceEnd + (finalCodePoint !== undefined && finalCodePoint > 0xffff ? 2 : 1))
    const snippetEnd = Math.min(pageText.length, endOffset + 48)
    results.push({
      pageNumber,
      offset: sourceStart,
      endOffset,
      snippet: `${snippetStart > 0 ? '…' : ''}${pageText.slice(snippetStart, snippetEnd)}${snippetEnd < pageText.length ? '…' : ''}`,
    })
  }
  return results
}

/** Map one clicked result back to the pdf.js text items that visually contain it. */
export function pdfSearchHighlightSlices(
  items: readonly unknown[],
  result: Pick<PdfSearchResult, 'offset' | 'endOffset'>,
): readonly PdfSearchHighlightSlice[] {
  const layout = pdfPageTextLayout(items)
  return layout.runs.flatMap((run) => {
    const overlapStart = Math.max(run.start, result.offset)
    const overlapEnd = Math.min(run.end, result.endOffset)
    if (overlapStart >= overlapEnd || run.end <= run.start) return []
    const length = run.end - run.start
    return [{
      itemIndex: run.itemIndex,
      startRatio: (overlapStart - run.start) / length,
      endRatio: (overlapEnd - run.start) / length,
    }]
  })
}
