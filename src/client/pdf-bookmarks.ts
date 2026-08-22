import type { PdfOutlineItem, ResolvedPdfOutlineItem } from './pdf-outline.ts'

/** One editable PDF outline entry retained in pre-order. */
export interface PdfBookmark {
  id: string
  parentId: string | null
  title: string
  /** One-based internal PDF page destination. */
  pageNumber?: number
  /** External URI retained from an existing PDF outline entry. */
  url?: string
  bold?: boolean
  italic?: boolean
  color?: readonly [number, number, number]
  /** Retain an uncommon source Dest/A object when this entry is otherwise edited. */
  preserveSourceAction?: boolean
}

export interface PdfBookmarkDraft {
  id: string
  parentId: string | null
  title: string
  pageNumber?: number
}

export const MAX_PDF_BOOKMARKS = 2_000
export const MAX_PDF_BOOKMARK_TITLE_LENGTH = 500

export function isSafeExternalPdfBookmarkUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol.toLowerCase()
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

function boundedTitle(title: string): string {
  const normalized = title.trim()
  if (normalized.length === 0) throw new Error('书签名称不能为空')
  if (normalized.length > MAX_PDF_BOOKMARK_TITLE_LENGTH) {
    throw new Error(`书签名称不能超过 ${String(MAX_PDF_BOOKMARK_TITLE_LENGTH)} 个字符`)
  }
  return normalized
}

function assertPageNumber(pageNumber: number | undefined, totalPages?: number): void {
  if (pageNumber === undefined) return
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1
    || (totalPages !== undefined && pageNumber > totalPages)) {
    throw new Error(`书签页码无效：${String(pageNumber)}`)
  }
}

/** Descendant ids in document order, excluding the requested root. */
export function pdfBookmarkDescendantIds(
  bookmarks: readonly PdfBookmark[],
  bookmarkId: string,
): ReadonlySet<string> {
  const descendants = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const bookmark of bookmarks) {
      if (descendants.has(bookmark.id)) continue
      if (bookmark.parentId === bookmarkId
        || (bookmark.parentId !== null && descendants.has(bookmark.parentId))) {
        descendants.add(bookmark.id)
        changed = true
      }
    }
  }
  return descendants
}

/** Parent candidates that cannot create a self/descendant cycle. */
export function pdfBookmarkParentCandidates(
  bookmarks: readonly PdfBookmark[],
  bookmarkId?: string,
): readonly PdfBookmark[] {
  if (bookmarkId === undefined) return bookmarks
  const excluded = pdfBookmarkDescendantIds(bookmarks, bookmarkId)
  return bookmarks.filter(bookmark => bookmark.id !== bookmarkId && !excluded.has(bookmark.id))
}

/** Validate the flat pre-order model before it is persisted into a PDF. */
export function validatePdfBookmarks(
  bookmarks: readonly PdfBookmark[],
  totalPages?: number,
): void {
  if (bookmarks.length > MAX_PDF_BOOKMARKS) {
    throw new Error(`PDF 书签过多（最多 ${String(MAX_PDF_BOOKMARKS)} 条）`)
  }
  const seen = new Set<string>()
  for (const bookmark of bookmarks) {
    if (bookmark.id.length === 0 || bookmark.id.length > 512 || seen.has(bookmark.id)) {
      throw new Error('PDF 书签包含无效或重复的标识')
    }
    boundedTitle(bookmark.title)
    assertPageNumber(bookmark.pageNumber, totalPages)
    if (bookmark.parentId !== null && !seen.has(bookmark.parentId)) {
      throw new Error('PDF 书签层级无效：父书签必须位于子书签之前')
    }
    if (bookmark.url !== undefined && bookmark.url.length > 8_192) {
      throw new Error('PDF 书签链接过长')
    }
    if (bookmark.color !== undefined
      && bookmark.color.some(component => !Number.isFinite(component) || component < 0 || component > 1)) {
      throw new Error('PDF 书签颜色无效')
    }
    seen.add(bookmark.id)
  }
}

/** Append a new bookmark after the selected parent's complete subtree. */
export function addPdfBookmark(
  bookmarks: readonly PdfBookmark[],
  draft: PdfBookmarkDraft,
  totalPages?: number,
): readonly PdfBookmark[] {
  if (bookmarks.some(bookmark => bookmark.id === draft.id)) throw new Error('书签标识重复')
  if (bookmarks.length >= MAX_PDF_BOOKMARKS) {
    throw new Error(`PDF 书签已达到 ${String(MAX_PDF_BOOKMARKS)} 条上限`)
  }
  if (draft.parentId !== null && !bookmarks.some(bookmark => bookmark.id === draft.parentId)) {
    throw new Error('选择的父书签已经不存在')
  }
  const bookmark: PdfBookmark = {
    id: draft.id,
    parentId: draft.parentId,
    title: boundedTitle(draft.title),
    ...(draft.pageNumber === undefined ? {} : { pageNumber: draft.pageNumber }),
  }
  assertPageNumber(bookmark.pageNumber, totalPages)
  if (bookmark.parentId === null) return [...bookmarks, bookmark]

  const descendants = pdfBookmarkDescendantIds(bookmarks, bookmark.parentId)
  let insertionIndex = bookmarks.findIndex(candidate => candidate.id === bookmark.parentId) + 1
  while (insertionIndex < bookmarks.length && descendants.has(bookmarks[insertionIndex]!.id)) insertionIndex += 1
  return [...bookmarks.slice(0, insertionIndex), bookmark, ...bookmarks.slice(insertionIndex)]
}

/** Update one entry and, when needed, move its complete subtree as a unit. */
export function updatePdfBookmark(
  bookmarks: readonly PdfBookmark[],
  bookmarkId: string,
  draft: Omit<PdfBookmarkDraft, 'id'>,
  totalPages?: number,
): readonly PdfBookmark[] {
  const index = bookmarks.findIndex(bookmark => bookmark.id === bookmarkId)
  const current = bookmarks[index]
  if (current === undefined) throw new Error('要编辑的书签已经不存在')
  const descendants = pdfBookmarkDescendantIds(bookmarks, bookmarkId)
  if (draft.parentId === bookmarkId || (draft.parentId !== null && descendants.has(draft.parentId))) {
    throw new Error('不能把书签移动到它自己的子书签下')
  }
  if (draft.parentId !== null && !bookmarks.some(bookmark => bookmark.id === draft.parentId)) {
    throw new Error('选择的父书签已经不存在')
  }
  assertPageNumber(draft.pageNumber, totalPages)
  const updated: PdfBookmark = {
    ...current,
    parentId: draft.parentId,
    title: boundedTitle(draft.title),
    ...(draft.pageNumber === undefined ? {} : { pageNumber: draft.pageNumber }),
  }
  if (draft.pageNumber === undefined) delete updated.pageNumber
  else delete updated.url

  if (draft.parentId === current.parentId) {
    return bookmarks.map(bookmark => bookmark.id === bookmarkId ? updated : bookmark)
  }

  const subtreeIds = new Set([bookmarkId, ...descendants])
  const subtree = bookmarks.filter(bookmark => subtreeIds.has(bookmark.id))
    .map(bookmark => bookmark.id === bookmarkId ? updated : bookmark)
  const remaining = bookmarks.filter(bookmark => !subtreeIds.has(bookmark.id))
  if (draft.parentId === null) return [...remaining, ...subtree]
  const parentDescendants = pdfBookmarkDescendantIds(remaining, draft.parentId)
  let insertionIndex = remaining.findIndex(bookmark => bookmark.id === draft.parentId) + 1
  while (insertionIndex < remaining.length && parentDescendants.has(remaining[insertionIndex]!.id)) insertionIndex += 1
  return [...remaining.slice(0, insertionIndex), ...subtree, ...remaining.slice(insertionIndex)]
}

/** Remove one bookmark and every descendant that depends on it. */
export function removePdfBookmark(
  bookmarks: readonly PdfBookmark[],
  bookmarkId: string,
): readonly PdfBookmark[] {
  if (!bookmarks.some(bookmark => bookmark.id === bookmarkId)) return bookmarks
  const removed = new Set(pdfBookmarkDescendantIds(bookmarks, bookmarkId))
  removed.add(bookmarkId)
  return bookmarks.filter(bookmark => !removed.has(bookmark.id))
}

/** Stable editor-state fingerprint. IDs are mapped to positions, not persisted identity. */
export function pdfBookmarkFingerprint(bookmarks: readonly PdfBookmark[]): string {
  const indexes = new Map(bookmarks.map((bookmark, index) => [bookmark.id, index]))
  return JSON.stringify(bookmarks.map(bookmark => ({
    parent: bookmark.parentId === null ? null : indexes.get(bookmark.parentId) ?? -1,
    title: bookmark.title,
    pageNumber: bookmark.pageNumber ?? null,
    url: bookmark.url ?? null,
    bold: bookmark.bold === true,
    italic: bookmark.italic === true,
    color: bookmark.color ?? null,
    preserveSourceAction: bookmark.preserveSourceAction === true,
  })))
}

/** Adapt editable bookmarks to the existing outline/navigation controller. */
export function pdfBookmarksToOutline(bookmarks: readonly PdfBookmark[]): {
  items: readonly ResolvedPdfOutlineItem[]
  pages: ReadonlyMap<string, number>
} {
  const depths = new Map<string, number>()
  const parentIds = new Set(bookmarks.map(bookmark => bookmark.parentId).filter(parentId => parentId !== null))
  const pages = new Map<string, number>()
  const items = bookmarks.map((bookmark): ResolvedPdfOutlineItem => {
    const depth = bookmark.parentId === null ? 0 : (depths.get(bookmark.parentId) ?? 0) + 1
    depths.set(bookmark.id, depth)
    if (bookmark.pageNumber !== undefined) pages.set(bookmark.id, bookmark.pageNumber)
    return {
      id: bookmark.id,
      parentId: bookmark.parentId,
      title: bookmark.title,
      depth: Math.min(16, depth),
      hasChildren: parentIds.has(bookmark.id),
      navigable: bookmark.pageNumber !== undefined
        || (bookmark.url !== undefined && isSafeExternalPdfBookmarkUrl(bookmark.url)),
      ...(bookmark.pageNumber === undefined ? {} : { pageNumber: bookmark.pageNumber }),
      ...(bookmark.url === undefined ? {} : { external: true }),
      destination: null,
    }
  })
  return { items, pages }
}

export function pdfOutlineItemById(
  items: readonly PdfOutlineItem[],
  id: string,
): PdfOutlineItem | undefined {
  return items.find(item => item.id === id)
}
