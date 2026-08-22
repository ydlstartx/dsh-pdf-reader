import type { PDFDocumentProxy } from './pdfjs.ts'
import type { PdfSearchController } from './pdf-search.ts'

interface PageRef {
  num: number
  gen: number
}

/** The subset of pdf.js's recursive outline node used by this plugin. */
export interface RawPdfOutlineNode {
  title: string
  dest: string | readonly unknown[] | null
  url: string | null
  items: readonly RawPdfOutlineNode[]
}

/** One bounded, display-ready outline row. */
export interface PdfOutlineItem {
  id: string
  parentId: string | null
  title: string
  depth: number
  hasChildren: boolean
  navigable: boolean
  /** Editable internal destination, when this row is backed by the bookmark model. */
  pageNumber?: number
  /** True when this entry opens a retained external URI rather than a PDF page. */
  external?: boolean
}

export interface PdfOutlineBookmarkDraft {
  parentId: string | null
  title: string
  pageNumber?: number
}

/** One private row retains the destination used when the user activates it. */
export interface ResolvedPdfOutlineItem extends PdfOutlineItem {
  destination: string | readonly unknown[] | null
}

/** Shared view handed to either the Harness sidebar or the narrow drawer. */
export interface PdfOutlineController {
  documentName: string
  items: readonly PdfOutlineItem[]
  expandedIds: ReadonlySet<string>
  search: PdfSearchController
  /** Deepest outline entry whose destination is at or before the visible page. */
  currentItemId: string | undefined
  /** Current entry, or its nearest ancestor when that entry is collapsed. */
  visibleCurrentItemId: string | undefined
  currentPage: number
  totalPages: number
  editable: boolean
  toggleExpanded: (id: string) => void
  setAllExpanded: (expanded: boolean) => void
  /** Explicitly reveal the current entry without changing folds during scrolling. */
  revealCurrent: () => void
  navigate: (id: string) => void
  addBookmark: (draft: PdfOutlineBookmarkDraft) => void
  updateBookmark: (id: string, draft: PdfOutlineBookmarkDraft) => void
  removeBookmark: (id: string) => void
}

/** Defensive DOM ceiling for a user-selected, potentially malformed PDF. */
export const MAX_OUTLINE_ITEMS = 2_000

/**
 * Flatten a PDF outline without recursive calls. Source order is retained;
 * excessively deep indentation is visually capped while descendants remain.
 */
export function flattenPdfOutline(
  roots: readonly RawPdfOutlineNode[],
  limit = MAX_OUTLINE_ITEMS,
): readonly ResolvedPdfOutlineItem[] {
  const boundedLimit = Math.max(0, Math.floor(limit))
  const output: ResolvedPdfOutlineItem[] = []
  const stack = roots.map((node, index) => ({
    node,
    depth: 0,
    path: String(index + 1),
    parentId: null as string | null,
  })).reverse()
  while (stack.length > 0 && output.length < boundedLimit) {
    const current = stack.pop()
    if (current === undefined) break
    const title = current.node.title.trim() || '未命名书签'
    output.push({
      id: current.path,
      parentId: current.parentId,
      title,
      depth: Math.min(16, current.depth),
      hasChildren: false,
      navigable: current.node.dest !== null,
      destination: current.node.dest,
    })
    for (let index = current.node.items.length - 1; index >= 0; index -= 1) {
      const child = current.node.items[index]
      if (child !== undefined) {
        stack.push({
          node: child,
          depth: current.depth + 1,
          path: `${current.path}.${String(index + 1)}`,
          parentId: current.path,
        })
      }
    }
  }
  const parentIds = new Set(output.map(item => item.parentId).filter(parentId => parentId !== null))
  for (const item of output) item.hasChildren = parentIds.has(item.id)
  return output
}

/** Project one pre-order outline through the current bounded expansion set. */
export function visiblePdfOutlineItems(
  items: readonly PdfOutlineItem[],
  expandedIds: ReadonlySet<string>,
): readonly PdfOutlineItem[] {
  const visibleById = new Map<string, boolean>()
  const visible: PdfOutlineItem[] = []
  for (const item of items) {
    const shown = item.parentId === null
      || (visibleById.get(item.parentId) === true && expandedIds.has(item.parentId))
    visibleById.set(item.id, shown)
    if (shown) visible.push(item)
  }
  return visible
}

/**
 * Pick the most specific bookmark at or before a 1-based page. PDF outlines
 * do not guarantee one destination per page; equal-page entries prefer the
 * deeper row, while equal-depth siblings retain source order because their
 * within-page vertical position is unknown here.
 */
export function currentPdfOutlineItemId(
  items: readonly PdfOutlineItem[],
  pages: ReadonlyMap<string, number>,
  currentPage: number,
): string | undefined {
  let current: PdfOutlineItem | undefined
  let currentDestination = -1
  for (const item of items) {
    const destination = pages.get(item.id)
    if (destination === undefined || destination > currentPage) continue
    if (destination > currentDestination
      || (destination === currentDestination && (current === undefined || item.depth > current.depth))) {
      current = item
      currentDestination = destination
    }
  }
  return current?.id
}

/** Find the nearest currently visible row representing one current entry. */
export function visibleCurrentPdfOutlineItemId(
  items: readonly PdfOutlineItem[],
  expandedIds: ReadonlySet<string>,
  currentItemId: string | undefined,
): string | undefined {
  if (currentItemId === undefined) return undefined
  const visibleIds = new Set(visiblePdfOutlineItems(items, expandedIds).map(item => item.id))
  const byId = new Map(items.map(item => [item.id, item]))
  let candidate: string | null = currentItemId
  while (candidate !== null) {
    if (visibleIds.has(candidate)) return candidate
    candidate = byId.get(candidate)?.parentId ?? null
  }
  return undefined
}

/** Parent ids from the root down to (but excluding) one outline entry. */
export function pdfOutlineAncestorIds(
  items: readonly PdfOutlineItem[],
  itemId: string,
): readonly string[] {
  const byId = new Map(items.map(item => [item.id, item]))
  const ancestors: string[] = []
  let parentId = byId.get(itemId)?.parentId
  while (parentId !== null && parentId !== undefined) {
    ancestors.push(parentId)
    parentId = byId.get(parentId)?.parentId
  }
  return ancestors.reverse()
}

function isPageRef(value: unknown): value is PageRef {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<PageRef>
  return Number.isInteger(candidate.num) && Number.isInteger(candidate.gen)
}

/** Resolve an internal PDF destination to a 1-based page number. */
export async function outlineDestinationPage(
  doc: Pick<PDFDocumentProxy, 'getDestination' | 'getPageIndex' | 'numPages'>,
  destination: string | readonly unknown[] | null,
): Promise<number | undefined> {
  const explicit = typeof destination === 'string' ? await doc.getDestination(destination) : destination
  const target = explicit?.[0]
  let pageIndex: number | undefined
  if (Number.isInteger(target) && typeof target === 'number') pageIndex = target
  else if (isPageRef(target)) pageIndex = await doc.getPageIndex(target)
  if (pageIndex === undefined || pageIndex < 0 || pageIndex >= doc.numPages) return undefined
  return pageIndex + 1
}
