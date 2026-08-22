/**
 * The reader surface: continuous-scroll page rendering on canvas, a
 * rectangular selection box over every page (text and image content alike —
 * the selection is pixels), attached to the host conversation composer.
 * The whole document is retained as numeric geometry plus one overflow box;
 * DOM pages, pdf.js proxies, and canvases are bounded to current ±2. Active
 * pages paint at the selected fit mode times user zoom, devicePixelRatio-sharp.
 * @module dsh-pdf-reader/client/PdfViewer
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { computeWideGeometry } from './geometry.ts'
import { loadPdfDocument, TextLayer } from './pdfjs.ts'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from './pdfjs.ts'
import {
  base64ByteLength,
  constrainedPaintScale,
  fitWithinPixels,
} from './render-constraints.ts'
import type { ComposerImageLimits } from './composer-selection.ts'
import { MAX_PDF_AI_QUESTION_CODE_UNITS } from './composer-pdf-reference.ts'
import type { PdfAiAction, PdfAnnotationAiAction } from './composer-pdf-reference.ts'
import { MAX_PDF_IMAGE_AI_QUESTION_CODE_UNITS } from './composer-pdf-image.ts'
import type { PdfImageAiAction } from './composer-pdf-image.ts'
import type { PdfMixedAiAction } from './composer-pdf-mixed.ts'
import { PdfEvidenceDrawer } from './PdfEvidenceDrawer.tsx'
import {
  addPdfTextEvidence,
  pdfTextEvidenceSources,
} from './pdf-evidence.ts'
import type { PdfTextEvidence } from './pdf-evidence.ts'
import type { PdfCitationImageTarget, PdfCitationTarget } from './pdf-citations.ts'
import type { PdfStoredReadingAnchor, PdfViewerSessionState } from './pdf-session-store.ts'
import { PdfAnnotationDrawer } from './PdfAnnotationDrawer.tsx'
import { PdfOutlinePanel } from './PdfOutlineSidebar.tsx'
import type { PdfSidebarMode } from './PdfOutlineSidebar.tsx'
import { PdfThumbnailDrawer } from './PdfThumbnailDrawer.tsx'
import {
  currentPdfOutlineItemId,
  pdfOutlineAncestorIds,
  visibleCurrentPdfOutlineItemId,
} from './pdf-outline.ts'
import type { PdfOutlineController, ResolvedPdfOutlineItem } from './pdf-outline.ts'
import {
  isSafeExternalPdfBookmarkUrl,
  MAX_PDF_BOOKMARKS,
  pdfBookmarkDescendantIds,
  pdfBookmarksToOutline,
} from './pdf-bookmarks.ts'
import type { PdfBookmark } from './pdf-bookmarks.ts'
import {
  findPdfTextMatches,
  isBlankPdfSearchQuery,
  MAX_PDF_SEARCH_CACHE_CODE_UNITS,
  MAX_PDF_SEARCH_QUERY_LENGTH,
  MAX_PDF_SEARCH_RESULTS,
  MAX_PDF_SEARCH_TOTAL_RESULTS,
  PDF_SEARCH_CONCURRENCY,
  pdfPageText,
  pdfSearchHighlightSlices,
} from './pdf-search.ts'
import type { PdfSearchResult, PdfSearchState } from './pdf-search.ts'
import {
  mergePdfTextSelectionRects,
  pdfTextBlankCaretTarget,
  pdfTextClosestLineFragmentIndexes,
} from './pdf-text-selection.ts'
import {
  MAX_PDF_ANNOTATION_NOTE_LENGTH,
  PDF_MARKUP_COLORS,
  pdfMarkupColorOption,
  pdfMarkupStrokeWidthCssPixels,
  pdfTextMarkupKindLabel,
} from './pdf-annotations.ts'
import type {
  PdfTextMarkupAnnotation,
  PdfTextMarkupGroup,
  PdfMarkupColor,
  PdfMarkupStrokeWidth,
  PdfTextMarkupDraft,
  PdfTextMarkupKind,
} from './pdf-annotations.ts'
import {
  PDF_STACK_BOTTOM_PADDING,
  pdfPageFitPageScale,
  pdfPageFitScale,
  pdfPageStackLayout,
  visiblePdfPageNumber,
} from './pdf-page-layout.ts'
import type { PdfPageSize as PageSize, PdfPageStackLayout as PageStackLayout } from './pdf-page-layout.ts'
import {
  effectivePdfPageRotation,
  normalizePdfRotation,
  rotateNormalizedPdfPoint,
  rotateNormalizedPdfRect,
} from './pdf-rotation.ts'
import type { PdfPageRotation } from './pdf-rotation.ts'
import {
  MAX_PDF_DOCUMENT_INDEX_CODE_UNITS,
  MAX_PDF_DOCUMENT_INDEX_PAGES_PER_BATCH,
} from '../pdf-document-index.ts'
import type { PdfDocumentIndexOutlineItem, PdfDocumentIndexPage } from '../pdf-document-index.ts'
import { createPdfDocumentId, syncPdfDocumentIndex } from './pdf-document-index-sync.ts'
import { shouldStopAutomaticPdfIndex, waitForPdfIndexIdle } from './pdf-index-policy.ts'
import {
  PDF_OCR_DEFAULT_PAGE_BUDGET,
  PDF_OCR_DEFAULT_PAGES_PER_BATCH,
  PDF_OCR_DEFAULT_VISUAL_BUDGET,
} from '../pdf-ocr.ts'
import {
  DEFAULT_PDF_OCR_PREFERENCES,
  loadPdfOcrPreferences,
  savePdfOcrPreferences,
} from './pdf-ocr-preferences.ts'
import type { PdfOcrPreferences } from './pdf-ocr-preferences.ts'

/** One committed selection box and its bounded screenshot. */
export interface SelectionInfo {
  /** 1-based page the box was drawn on. */
  pageNumber: number
  /** Box normalized to the page (0..1), so its marker survives zoom changes. */
  rect: Rect
  /** Non-destructive page-view rotation at the time this crop was created. */
  rotation: PdfPageRotation
  /** Cropped PNG, base64 without the data: prefix. */
  pngBase64: string
}

/** One conversation-level evidence image with its owning PDF retained. */
export interface PdfEvidenceImage extends SelectionInfo {
  documentId: string
  documentName: string
}

export interface PdfViewerDocumentTab {
  documentId: string
  name: string
  currentPage: number
  editorDirty: boolean
}

export interface PdfViewerProps {
  /** Raw PDF bytes (copied before handoff — pdf.js detaches the buffer). */
  bytes: ArrayBuffer
  /** Conversation identity used to bind the host-side tool index. */
  sessionId: string
  /** Random document generation used to reject stale index batches and citations. */
  documentId: string
  /** Browser-selected filename shown in the outline navigation surface. */
  documentName: string
  /** Conversation-local open documents shown as browser-style tabs. */
  documents: readonly PdfViewerDocumentTab[]
  activeDocumentId: string
  onDocumentActivate: (documentId: string) => void
  onDocumentClose: (documentId: string) => void
  /** Publish the current host-index generation so an explicit tab close can release it. */
  onDocumentIndexChange: (documentId: string, indexId: string) => void
  /** Ordered crops mirrored into the host conversation composer. */
  selections: readonly SelectionInfo[]
  /** Ordered crops explicitly moved into the PDF-only evidence basket. */
  evidenceImages: readonly PdfEvidenceImage[]
  textEvidence: readonly PdfTextEvidence[]
  selectedEvidenceImages: readonly PdfEvidenceImage[]
  selectedTextEvidenceIds: ReadonlySet<string>
  onTextEvidenceChange: (sources: readonly PdfTextEvidence[]) => void
  onEvidenceSelectionChange: (images: readonly PdfEvidenceImage[], textIds: ReadonlySet<string>) => void
  /** Unsaved, document-local text markups. */
  annotations: readonly PdfTextMarkupAnnotation[]
  /** Unsaved, document-local standard PDF outline entries. */
  bookmarks: readonly PdfBookmark[]
  /** Append one crop to the host conversation composer. */
  onSelectionAdd: (selection: SelectionInfo) => void
  /** Release one crop and its matching host-composer attachment. */
  onSelectionRemove: (selection: SelectionInfo) => void
  /** Detach one normal composer image and move it into PDF evidence. */
  onSelectionMoveToEvidence: (selection: SelectionInfo) => void
  /** Remove one PDF-only evidence image. */
  onEvidenceImageRemove: (selection: PdfEvidenceImage) => void
  /** Clear PDF-only evidence images without touching normal composer attachments. */
  onEvidenceImagesClear: () => void
  /** Commit one native text selection as a possibly cross-page markup group. */
  onTextMarkupAdd: (drafts: readonly PdfTextMarkupDraft[], kind: PdfTextMarkupKind, color: PdfMarkupColor, strokeWidth: PdfMarkupStrokeWidth) => string | undefined
  /** Recolor every page-local member of one logical markup. */
  onTextMarkupColorChange: (groupId: string, color: PdfMarkupColor) => void
  /** Delete every page-local member of one logical markup. */
  onTextMarkupRemove: (groupId: string) => void
  /** Set or clear the note shared by one logical markup group. */
  onTextMarkupNoteChange: (groupId: string, note: string) => void
  /** Change the line thickness shared by one underline or strikeout group. */
  onTextMarkupStrokeWidthChange: (groupId: string, strokeWidth: PdfMarkupStrokeWidth) => void
  onBookmarkAdd: (draft: { parentId: string | null; title: string; pageNumber?: number }) => void
  onBookmarkUpdate: (id: string, draft: { parentId: string | null; title: string; pageNumber?: number }) => void
  onBookmarkRemove: (id: string) => void
  /** Whether in-memory annotations or bookmarks differ from the last explicit save. */
  editorDirty: boolean
  /** Whether this document was opened with a writable native file handle. */
  canOverwrite: boolean
  /** Active explicit save operation, if any. */
  saveBusy: 'save-as' | 'overwrite' | undefined
  /** Most recent save failure; the source and current reader state stay intact. */
  saveError: string | undefined
  /** Write a new annotated PDF without changing the original file. */
  onSaveAs: () => Promise<void>
  /** Explicitly replace the handle-backed source after caller confirmation. */
  onOverwrite: () => Promise<void>
  /** Append selected text plus its source pages to the editable AI draft. */
  onTextReferenceAdd: (text: string, pageNumbers: readonly number[]) => void
  /** Send one question against the immutable document scope chosen in the dialog. */
  onDocumentsQuestion: (
    question: string,
    documents: readonly { documentId: string; currentPage: number }[],
    ocrPreferences?: PdfOcrPreferences,
  ) => Promise<void>
  /** Queue an explicit AI reading action in the current conversation. */
  onTextAiRequest: (action: PdfAiAction, text: string, pageNumbers: readonly number[], question?: string) => Promise<void>
  /** Queue one AI turn over the annotation center's current filter. */
  onAnnotationAiRequest: (action: PdfAnnotationAiAction, groups: readonly PdfTextMarkupGroup[], question?: string) => Promise<void>
  /** Queue one explicit image-region AI action without consuming composer state. */
  onImageAiRequest: (action: PdfImageAiAction, question?: string) => Promise<void>
  /** Queue one explicitly selected image-region + native-text AI turn. */
  onMixedAiRequest: (action: PdfMixedAiAction, images: readonly PdfEvidenceImage[], texts: readonly PdfTextEvidence[], question?: string) => Promise<void>
  onEvidenceNavigateImage: (selection: PdfEvidenceImage) => void
  onEvidenceNavigateText: (source: PdfTextEvidence) => void
  /** Most recent click on a source link inside an AI answer. */
  citationNavigation: { target: PdfCitationTarget; revision: number } | undefined
  /** Restored conversation-local view and text-evidence state for this document. */
  initialSessionState: PdfViewerSessionState | undefined
  /** Publish a lightweight view/evidence snapshot for debounced local persistence. */
  onSessionStateChange: (state: PdfViewerSessionState) => void
  /** Non-fatal local persistence failure; the in-memory reader remains usable. */
  persistenceError: string | undefined
  /** Open the browser chooser while retaining this document until a replacement succeeds. */
  onReplace: () => void
  /** Release the current document and return to the unopened reader state. */
  onCloseDocument: () => void
  /** Whether a selected replacement is currently being read. */
  replaceBusy: boolean
  /** File-selection failure; the current document remains usable. */
  replaceError: string | undefined
  /** Host-projected limits enforced before the screenshot enters a prompt. */
  imageLimits: ComposerImageLimits | undefined
  /** Whether the floating reader window is open (controlled by the panel). */
  wide: boolean
  /** Conversation-shared divider width retained while active PDF instances switch. */
  initialWideWidth: number
  /** Retain an explicitly dragged divider width for the next active PDF instance. */
  onWideWidthChange: (width: number) => void
  /** Request a window open/close — the panel owns the state and the layout sync. */
  onWideChange: (open: boolean) => void
  /** Publish the desktop-sidebar outline while the reader can expose it. */
  onOutlineChange: (outline: PdfOutlineController | undefined) => void
  /** Toggle the desktop PDF search surface; returns whether it is open. */
  onSearchToggle: () => boolean
}

/** CSS-px rectangle relative to one page canvas. */
interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Point {
  x: number
  y: number
}

interface ClientRectSnapshot {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

interface PendingPdfTextSelection {
  text: string
  drafts: readonly PdfTextMarkupDraft[]
  anchor: ClientRectSnapshot
}

type PdfAnnotationMenuState =
  | { kind: 'selection'; pending: PendingPdfTextSelection }
  | { kind: 'annotation'; groupId: string; anchor: ClientRectSnapshot }

interface PdfImageAiMenuState {
  selection: SelectionInfo
  anchor: ClientRectSnapshot
}

type PdfInteractionMode = 'text' | 'crop'
type PdfTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>

const PDF_TEXT_LAYER_CSS = `
[data-pdf-text-layer="true"] {
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
}
[data-pdf-text-layer="true"] :is(span, br) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
  user-select: text;
}
[data-pdf-text-layer="true"] > :not(.markedContent),
[data-pdf-text-layer="true"] .markedContent span:not(.markedContent) {
  z-index: 1;
  --font-height: 0;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  --scale-x: 1;
  --rotate: 0deg;
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}
[data-pdf-text-layer="true"] .markedContent { display: contents; }
[data-pdf-text-layer="true"] ::selection {
  background: transparent;
  color: transparent;
}
[data-pdf-annotation-action="true"]:hover {
  background-color: rgba(0, 0, 0, 0.055) !important;
  color: #18181b !important;
}
[data-pdf-annotation-action="true"]:focus-visible {
  outline: 2px solid rgba(77, 107, 254, 0.72);
  outline-offset: -2px;
}
@keyframes pdf-evidence-source-flash {
  0%, 72% { opacity: 1; }
  100% { opacity: 0; }
}
[data-pdf-evidence-highlight="true"] {
  animation: pdf-evidence-source-flash 2.4s ease-out forwards;
}
[data-pdf-ai-action]:hover {
  background-color: rgba(77, 107, 254, 0.07) !important;
}
[data-pdf-ai-action]:focus-visible {
  outline: 2px solid rgba(77, 107, 254, 0.62);
  outline-offset: -2px;
}
`

interface PdfSearchSession {
  query: string
  nextPage: number
  pageMatchOffset: number
  results: PdfSearchResult[]
  scannedPages: number
  failedPages: number
  hasSearchableText: boolean
}

interface ActivePdfSearchHit {
  query: string
  result: PdfSearchResult
}

/** Content point kept under the viewport center while fit-width relayouts. */
interface PageLayoutAnchor {
  pageNumber: number
  pageXRatio: number
  pageYRatio: number
  viewportX: number
  viewportY: number
}

/** One document-local reading point kept by explicit navigation history. */
interface PdfNavigationLocation {
  pageNumber: number
  pageXRatio: number
  pageYRatio: number
  rotation: PdfPageRotation
}

interface PdfNavigationAvailability {
  back: boolean
  forward: boolean
}

type PdfFitMode = 'width' | 'page'

function emptyPdfSearchState(totalPages = 0): PdfSearchState {
  return {
    query: '',
    status: 'idle',
    results: [],
    scannedPages: 0,
    totalPages,
    hasSearchableText: false,
    truncated: false,
    failedPages: 0,
    error: undefined,
  }
}

function pdfSearchStateFromSession(
  totalPages: number,
  session: PdfSearchSession,
  status: PdfSearchState['status'],
  truncated = false,
): PdfSearchState {
  return {
    query: session.query,
    status,
    results: [...session.results],
    scannedPages: session.scannedPages,
    totalPages,
    hasSearchableText: session.hasSearchableText,
    truncated,
    failedPages: session.failedPages,
    error: undefined,
  }
}

function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

function snapshotClientRect(rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>): ClientRectSnapshot {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  }
}

function textCaretAtPoint(layer: HTMLElement, x: number, y: number): { node: Node; offset: number } | undefined {
  const position = document.caretPositionFromPoint?.(x, y)
  if (position !== undefined && position !== null && layer.contains(position.offsetNode)) {
    return { node: position.offsetNode, offset: position.offset }
  }
  const legacyDocument = document as Document & {
    caretRangeFromPoint?: (clientX: number, clientY: number) => Range | null
  }
  const range = legacyDocument.caretRangeFromPoint?.(x, y)
  return range !== undefined && range !== null && layer.contains(range.startContainer)
    ? { node: range.startContainer, offset: range.startOffset }
    : undefined
}

interface PdfTextCaretFragment {
  node: Text
  startOffset: number
  endOffset: number
  rtl: boolean
  rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>
  boundaries?: readonly PdfTextCaretBoundary[]
}

interface PdfTextCaretBoundary {
  offset: number
  x: number
}

interface PdfTextCaretGeometry {
  width: number
  height: number
  fragments: PdfTextCaretFragment[]
}

const pdfTextCaretGeometryCache = new WeakMap<HTMLElement, PdfTextCaretGeometry>()

function pdfTextCaretGeometry(layer: HTMLElement): { box: DOMRect; geometry: PdfTextCaretGeometry } {
  const box = layer.getBoundingClientRect()
  const cached = pdfTextCaretGeometryCache.get(layer)
  const firstNode = cached?.fragments[0]?.node
  const lastNode = cached?.fragments.at(-1)?.node
  if (cached !== undefined
    && Math.abs(cached.width - box.width) < 0.25
    && Math.abs(cached.height - box.height) < 0.25
    && (firstNode === undefined || layer.contains(firstNode))
    && (lastNode === undefined || layer.contains(lastNode))) {
    return { box, geometry: cached }
  }

  const fragments: PdfTextCaretFragment[] = []
  const range = document.createRange()
  const directions = new Map<HTMLElement, boolean>()
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  let current = walker.nextNode()
  while (current !== null) {
    if (current instanceof Text && current.data.trim().length > 0) {
      const element = current.parentElement?.closest<HTMLElement>('span')
      if (element !== undefined && element !== null && layer.contains(element)) {
        let rtl = directions.get(element)
        if (rtl === undefined) {
          rtl = getComputedStyle(element).direction === 'rtl'
          directions.set(element, rtl)
        }
        for (const match of current.data.matchAll(/\S+/gu)) {
          const startOffset = match.index
          const endOffset = startOffset + match[0].length
          range.setStart(current, startOffset)
          range.setEnd(current, endOffset)
          for (const rect of range.getClientRects()) {
            if (rect.width <= 0 || rect.height <= 0) continue
            fragments.push({
              node: current,
              startOffset,
              endOffset,
              rtl,
              rect: {
                left: rect.left - box.left,
                top: rect.top - box.top,
                right: rect.right - box.left,
                bottom: rect.bottom - box.top,
              },
            })
          }
        }
      }
    }
    current = walker.nextNode()
  }
  range.detach()
  const geometry = { width: box.width, height: box.height, fragments }
  pdfTextCaretGeometryCache.set(layer, geometry)
  return { box, geometry }
}

function pdfTextFragmentBoundaries(
  fragment: PdfTextCaretFragment,
  layerBox: Pick<DOMRect, 'left' | 'top'>,
): readonly PdfTextCaretBoundary[] {
  if (fragment.boundaries !== undefined) return fragment.boundaries
  const boundaries: PdfTextCaretBoundary[] = [{
    offset: fragment.startOffset,
    x: fragment.rtl ? fragment.rect.right : fragment.rect.left,
  }]
  const range = document.createRange()
  const fragmentCenter = (fragment.rect.top + fragment.rect.bottom) / 2
  let offset = fragment.startOffset
  for (const character of fragment.node.data.slice(fragment.startOffset, fragment.endOffset)) {
    const startOffset = offset
    offset += character.length
    range.setStart(fragment.node, startOffset)
    range.setEnd(fragment.node, offset)
    const rect = [...range.getClientRects()].sort((left, right) => {
      const leftDistance = Math.abs((left.top + left.bottom) / 2 - layerBox.top - fragmentCenter)
      const rightDistance = Math.abs((right.top + right.bottom) / 2 - layerBox.top - fragmentCenter)
      return leftDistance - rightDistance
    })[0]
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) continue
    boundaries.push({
      offset,
      x: (fragment.rtl ? rect.left : rect.right) - layerBox.left,
    })
  }
  range.detach()
  if (boundaries.at(-1)?.offset !== fragment.endOffset) {
    boundaries.push({
      offset: fragment.endOffset,
      x: fragment.rtl ? fragment.rect.left : fragment.rect.right,
    })
  }
  fragment.boundaries = boundaries
  return boundaries
}

function pdfVisualCaretAtPoint(layer: HTMLElement, x: number, y: number): { node: Node; offset: number } | undefined {
  const { box, geometry } = pdfTextCaretGeometry(layer)
  const entries = geometry.fragments
  const point = { x: x - box.left, y: y - box.top }
  const lineIndexes = pdfTextClosestLineFragmentIndexes(entries.map(({ rect }) => rect), point)
  const inside = lineIndexes.flatMap((index) => {
    const entry = entries[index]
    if (entry === undefined || point.x < entry.rect.left - 1 || point.x > entry.rect.right + 1) return []
    return [{
      entry,
      distance: Math.abs(point.x - (entry.rect.left + entry.rect.right) / 2),
    }]
  }).sort((left, right) => left.distance - right.distance)[0]
  if (inside !== undefined) {
    const boundary = [...pdfTextFragmentBoundaries(inside.entry, box)].sort((left, right) => (
      Math.abs(point.x - left.x) - Math.abs(point.x - right.x)
    ))[0]
    if (boundary !== undefined) return { node: inside.entry.node, offset: boundary.offset }
  }

  const target = pdfTextBlankCaretTarget(
    entries.map(({ rect }) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })),
    point,
  )
  const targetEntry = target === undefined ? undefined : entries[target.fragmentIndex]
  if (target === undefined || targetEntry === undefined) return undefined
  const logicalStart = targetEntry.rtl ? target.edge === 'right' : target.edge === 'left'
  return {
    node: targetEntry.node,
    offset: logicalStart ? targetEntry.startOffset : targetEntry.endOffset,
  }
}

function annotationMenuPosition(anchor: ClientRectSnapshot, width: number, height: number): { left: number; top: number } {
  const margin = 8
  const gap = 8
  const left = Math.min(
    window.innerWidth - width - margin,
    Math.max(margin, anchor.left + anchor.width / 2 - width / 2),
  )
  const preferredTop = anchor.top - height - gap
  const top = preferredTop >= margin
    ? preferredTop
    : Math.min(window.innerHeight - height - margin, anchor.bottom + gap)
  return { left, top }
}

const PDF_MARKUP_STROKE_WIDTHS: readonly { value: PdfMarkupStrokeWidth; label: string }[] = [
  { value: 1, label: '细线' },
  { value: 2, label: '中线' },
  { value: 3, label: '粗线' },
]

function pdfTextMarkupAppearance(
  kind: PdfTextMarkupKind,
  color: ReturnType<typeof pdfMarkupColorOption>,
  strokeWidth: PdfMarkupStrokeWidth,
  pageScale: number,
): CSSProperties {
  // The persisted /BS and appearance-stream widths are PDF user-space
  // units. Preview them through the same page scale instead of treating the
  // numeric value as a fixed CSS-pixel width; otherwise saving changes the
  // apparent thickness whenever fitScale is not exactly 1.
  const halfStroke = pdfMarkupStrokeWidthCssPixels(strokeWidth, pageScale) / 2
  if (kind === 'underline') {
    return {
      background: `linear-gradient(to bottom, transparent calc(92% - ${String(halfStroke)}px), ${color.hex} calc(92% - ${String(halfStroke)}px), ${color.hex} calc(92% + ${String(halfStroke)}px), transparent calc(92% + ${String(halfStroke)}px))`,
      transform: 'translateY(2px)',
    }
  }
  if (kind === 'strikeout') {
    return {
      background: `linear-gradient(to bottom, transparent calc(50% - ${String(halfStroke)}px), ${color.hex} calc(50% - ${String(halfStroke)}px), ${color.hex} calc(50% + ${String(halfStroke)}px), transparent calc(50% + ${String(halfStroke)}px))`,
    }
  }
  return { background: color.overlay }
}

async function copyPdfTextSelection(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // The native range is still selected because the floating menu preserves
    // it on pointerdown, so older/insecure hosts can use the browser fallback.
    try {
      return document.execCommand('copy')
    } catch {
      return false
    }
  }
}

/** Capture the page point nearest the viewport center before page sizes change. */
function capturePageLayoutAnchor(scroller: HTMLElement): PageLayoutAnchor | undefined {
  const scrollerRect = scroller.getBoundingClientRect()
  const viewportX = scroller.clientWidth / 2
  const viewportY = scroller.clientHeight / 2
  const clientX = scrollerRect.left + viewportX
  const clientY = scrollerRect.top + viewportY
  let nearest: { page: HTMLElement; rect: DOMRect; distance: number } | undefined

  for (const candidate of scroller.querySelectorAll<HTMLElement>('div[data-page]')) {
    const rect = candidate.getBoundingClientRect()
    const distance = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0
    if (nearest === undefined || distance < nearest.distance) nearest = { page: candidate, rect, distance }
    if (distance === 0) break
  }
  if (nearest === undefined || nearest.rect.width <= 0 || nearest.rect.height <= 0) return undefined

  const pageNumber = Number(nearest.page.dataset['page'])
  if (!Number.isInteger(pageNumber)) return undefined
  return {
    pageNumber,
    pageXRatio: Math.min(1, Math.max(0, (clientX - nearest.rect.left) / nearest.rect.width)),
    pageYRatio: Math.min(1, Math.max(0, (clientY - nearest.rect.top) / nearest.rect.height)),
    viewportX,
    viewportY,
  }
}

/** Restore one captured page point after the fit-width layout has committed. */
function restorePageLayoutAnchor(scroller: HTMLElement, anchor: PageLayoutAnchor): void {
  const page = scroller.querySelector<HTMLElement>(`div[data-page="${String(anchor.pageNumber)}"]`)
  if (page === null) return
  const scrollerRect = scroller.getBoundingClientRect()
  const pageRect = page.getBoundingClientRect()
  const targetX = pageRect.left + pageRect.width * anchor.pageXRatio
  const targetY = pageRect.top + pageRect.height * anchor.pageYRatio
  scroller.scrollLeft += targetX - (scrollerRect.left + anchor.viewportX)
  scroller.scrollTop += targetY - (scrollerRect.top + anchor.viewportY)
}

/** Restore against the current viewport center, even if the panel was resized. */
function restorePdfNavigationLocation(
  scroller: HTMLElement,
  location: PdfNavigationLocation,
  rotation: PdfPageRotation,
): void {
  const point = rotateNormalizedPdfPoint(
    { x: location.pageXRatio, y: location.pageYRatio },
    normalizePdfRotation(rotation - location.rotation),
  )
  restorePageLayoutAnchor(scroller, {
    ...location,
    pageXRatio: point.x,
    pageYRatio: point.y,
    viewportX: scroller.clientWidth / 2,
    viewportY: scroller.clientHeight / 2,
  })
}

/**
 * Keep DOM pages, pdf.js page proxies, and canvases in one small fixed window.
 * A numeric geometry array plus one sizer preserve continuous scrolling, page
 * jumps, and saved positions without mounting one element per document page.
 */
const PAGE_WINDOW_RADIUS = 2
const FALLBACK_PAGE_SIZE: PageSize = { width: 595, height: 842 }
/** One revisit preview stays below ~3 MiB decoded. */
const PAGE_PREVIEW_MAX_PIXELS = 750_000
/** Recent-page previews stay below ~24 MiB decoded, independent of document length. */
const PAGE_PREVIEW_CACHE_MAX_PIXELS = 6_000_000
/** Tiny pages cannot turn the pixel budget into an unbounded DOM-canvas cache. */
const PAGE_PREVIEW_CACHE_MAX_ENTRIES = 12
const PDF_ZOOM_MIN = 0.25
const PDF_ZOOM_MAX = 4
const PDF_ZOOM_STEP = 0.15
/** Fifty explicit jumps cover a long reading session while remaining trivially bounded. */
const MAX_PDF_NAVIGATION_HISTORY = 50
/** Extra hover reach around an invisible corner control, without a DOM hitbox. */
const CORNER_CONTROL_PROXIMITY_PX = 24
/** Brief grace period lets the pointer return without making controls flicker. */
const CORNER_CONTROL_HIDE_DELAY_MS = 600

/** Zoom shortcuts yield only where the user can actually enter text. */
function isPdfShortcutTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest(
    'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])',
  ) !== null
}

/** Space must additionally preserve native activation of focused controls. */
function isPdfShortcutSpaceTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return isPdfShortcutTextEntryTarget(target)
    || target.closest('button, a[href], [role="button"], [role="link"]') !== null
}

/** Read the already-rendered Harness sidebar before a replacement viewer's first paint. */
function currentHarnessSidebarWidth(): number {
  if (typeof document === 'undefined') return 0
  const frame = document.querySelector<HTMLElement>('div[style*="grid-template-columns"]')
  const sidebar = frame?.firstElementChild
  if (!(sidebar instanceof HTMLElement)) return 0
  const width = sidebar.getBoundingClientRect().width
  return Number.isFinite(width) && width > 0 ? width : 0
}

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flex: 1,
  } as const,
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    flex: '0 0 auto',
    minHeight: '32px',
    gap: '12px',
    paddingBottom: '10px',
    marginBottom: '8px',
    borderBottom: '1px solid rgba(0,0,0,0.08)',
    fontSize: '12px',
    color: '#595959',
  } as const,
  toolbarDocument: {
    display: 'flex',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
    gap: '7px',
  } as const,
  documentTabs: {
    display: 'flex',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
    gap: '3px',
    overflowX: 'auto',
    overflowY: 'hidden',
    paddingBottom: '5px',
    scrollbarWidth: 'thin',
    scrollbarColor: 'rgba(89, 89, 89, 0.28) transparent',
    overscrollBehaviorX: 'contain',
  } as const,
  documentTab: {
    appearance: 'none',
    display: 'flex',
    alignItems: 'center',
    flex: '0 0 168px',
    width: '168px',
    height: '30px',
    padding: '0 6px 0 9px',
    border: '1px solid transparent',
    borderRadius: '8px',
    background: 'transparent',
    color: '#595959',
    cursor: 'pointer',
  } as const,
  documentTabActive: {
    background: 'rgba(77, 107, 254, 0.09)',
    borderColor: 'rgba(77, 107, 254, 0.22)',
    color: '#2748d8',
  } as const,
  documentTabName: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'left',
    fontSize: '12px',
    lineHeight: '18px',
  } as const,
  documentTabDirty: {
    width: '6px',
    height: '6px',
    flex: '0 0 auto',
    borderRadius: '50%',
    background: '#fa8c16',
    marginLeft: '5px',
  } as const,
  documentTabClose: {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    flex: '0 0 auto',
    marginLeft: '3px',
    padding: 0,
    border: 'none',
    borderRadius: '5px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '14px',
  } as const,
  toolbarDocumentIcon: {
    display: 'inline-flex',
    flex: '0 0 auto',
    color: '#8c8c8c',
  } as const,
  toolbarFileName: {
    minWidth: 0,
    overflow: 'hidden',
    color: '#262626',
    fontSize: '12px',
    fontWeight: 500,
    lineHeight: '18px',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  toolbarActions: {
    display: 'flex',
    alignItems: 'center',
    flex: '0 0 auto',
    gap: '4px',
  } as const,
  toolButton: {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '5px',
    height: '30px',
    border: '1px solid transparent',
    background: 'rgba(0,0,0,0.045)',
    color: 'inherit',
    borderRadius: '8px',
    padding: '0 9px',
    cursor: 'pointer',
    fontSize: '12px',
    lineHeight: 1,
    whiteSpace: 'nowrap',
    transition: 'background-color 140ms ease, color 140ms ease, opacity 140ms ease',
  } as const,
  toolButtonInteractive: {
    background: 'rgba(0,0,0,0.08)',
    color: '#262626',
  } as const,
  toolButtonActive: {
    color: '#3154d8',
    background: 'rgba(77,107,254,0.13)',
    boxShadow: 'inset 0 0 0 1px rgba(77,107,254,0.28)',
  } as const,
  toolButtonDisabled: {
    cursor: 'default',
    opacity: 0.48,
  } as const,
  toolIconButton: {
    width: '30px',
    padding: 0,
  } as const,
  documentQuestionBackdrop: {
    position: 'absolute',
    inset: 0,
    zIndex: 1500,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '56px 16px 16px',
    boxSizing: 'border-box',
    background: 'rgba(30, 32, 40, 0.18)',
    backdropFilter: 'blur(1.5px)',
  } as const,
  documentQuestionDialog: {
    width: 'min(420px, 100%)',
    padding: '14px',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '12px',
    background: '#fff',
    color: '#27272a',
    boxShadow: '0 12px 36px rgba(0,0,0,0.22)',
    boxSizing: 'border-box',
  } as const,
  documentQuestionHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
    marginBottom: '10px',
  } as const,
  documentQuestionTitle: {
    fontSize: '14px',
    fontWeight: 650,
    lineHeight: 1.35,
  } as const,
  documentQuestionDocument: {
    marginTop: '3px',
    overflow: 'hidden',
    color: '#8a8a93',
    fontSize: '11px',
    lineHeight: 1.4,
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  documentQuestionStatus: {
    marginTop: '8px',
    color: '#71717a',
    fontSize: '11px',
    lineHeight: 1.4,
  } as const,
  pdfViewport: {
    position: 'relative',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  } as const,
  scroller: {
    width: '100%',
    height: '100%',
    overflow: 'auto',
    boxSizing: 'border-box',
    outline: 'none',
    // Chrome's scroll anchoring fights the pointer-anchored zoom math.
    overflowAnchor: 'none',
  } as const,
  floatingSurface: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    padding: '4px',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '10px',
    background: 'rgba(255,255,255,0.94)',
    color: '#595959',
    boxShadow: '0 3px 12px rgba(0,0,0,0.14)',
    backdropFilter: 'blur(8px)',
  } as const,
  floatingButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    padding: 0,
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '16px',
    lineHeight: 1,
  } as const,
  zoomControls: {
    position: 'absolute',
    right: '12px',
    bottom: '12px',
    zIndex: 12,
    transition: 'opacity 160ms ease',
    willChange: 'opacity',
  } as const,
  zoomLabel: {
    minWidth: '48px',
    textAlign: 'center',
    fontSize: '12px',
    fontVariantNumeric: 'tabular-nums',
    userSelect: 'none',
  } as const,
  navigationControls: {
    position: 'absolute',
    left: '12px',
    bottom: '12px',
    zIndex: 12,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '6px',
    transition: 'opacity 160ms ease',
    willChange: 'opacity',
  } as const,
  pageControl: {
    minWidth: '76px',
    height: '30px',
    padding: '0 9px',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '12px',
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'center',
  } as const,
  scrollerContent: {
    position: 'absolute',
    inset: '0 auto auto 0',
    // The page stack is permanently scaled on the compositor. A separate
    // sizer owns layout overflow, including shrink-to-25% where transforms
    // alone cannot reduce scrollHeight.
    transformOrigin: '0 0',
  } as const,
  zoomSizer: {
    position: 'relative',
    flexShrink: 0,
    margin: '0 auto',
  } as const,
  page: {
    background: '#fff',
    display: 'block',
  } as const,
  pageWrap: {
    position: 'relative',
    flexShrink: 0,
    boxShadow: '0 1px 6px rgba(0,0,0,0.18)',
    borderRadius: '2px',
    background: '#fff',
    overflow: 'hidden',
    // Centers the page while narrower than the scroller; collapses to plain
    // left alignment once wider, keeping both scroll directions reachable.
    margin: '0 auto',
  } as const,
  pageBookmarkButton: {
    position: 'absolute',
    top: '10px',
    right: '10px',
    zIndex: 10,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '30px',
    height: '30px',
    padding: 0,
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '8px',
    background: 'rgba(255,255,255,0.94)',
    color: '#4b5563',
    boxShadow: '0 2px 8px rgba(0,0,0,0.14)',
    cursor: 'pointer',
    transition: 'opacity 140ms ease, background-color 140ms ease, color 140ms ease',
    transformOrigin: 'top right',
  } as const,
  pageBookmarkButtonAdded: {
    color: '#4d6bfe',
    background: 'rgba(242,245,255,0.97)',
  } as const,
  selectLayer: {
    position: 'absolute',
    inset: 0,
    cursor: 'crosshair',
  } as const,
  textLayer: {
    position: 'absolute',
    inset: 0,
    overflow: 'clip',
    colorScheme: 'only light',
    textAlign: 'initial',
    lineHeight: 1,
    letterSpacing: 'normal',
    wordSpacing: 'normal',
    textSizeAdjust: 'none',
    forcedColorAdjust: 'none',
    transformOrigin: '0 0',
    caretColor: '#262626',
  } as const,
  pageError: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
    boxSizing: 'border-box',
    color: '#d4380d',
    background: 'rgba(255,255,255,0.92)',
    fontSize: '12px',
    textAlign: 'center',
  } as const,
  selectionBox: {
    position: 'absolute',
    border: '1.5px solid #4d6bfe',
    background: 'rgba(77,107,254,0.15)',
    pointerEvents: 'none',
    boxSizing: 'border-box',
  } as const,
  evidenceSelectionBox: {
    borderColor: '#7c5cff',
    background: 'rgba(124,92,255,0.14)',
  } as const,
  searchHighlight: {
    position: 'absolute',
    border: 'none',
    borderRadius: '2.5px',
    background: 'rgba(255, 211, 0, 0.38)',
    boxSizing: 'border-box',
    boxShadow: '0 0 0 1px rgba(255, 200, 0, 0.12)',
    mixBlendMode: 'multiply',
    pointerEvents: 'none',
  } as const,
  textSelectionHighlight: {
    position: 'absolute',
    borderRadius: '1.5px',
    background: 'rgba(77, 107, 254, 0.28)',
    pointerEvents: 'none',
    boxSizing: 'border-box',
  } as const,
  annotationLayer: {
    position: 'absolute',
    inset: 0,
    zIndex: 4,
    pointerEvents: 'none',
  } as const,
  annotationHighlight: {
    position: 'absolute',
    display: 'block',
    padding: 0,
    border: 'none',
    borderRadius: '1.5px',
    boxSizing: 'border-box',
    mixBlendMode: 'multiply',
    cursor: 'pointer',
    pointerEvents: 'auto',
  } as const,
  evidenceHighlight: {
    position: 'absolute',
    display: 'block',
    border: '1px solid rgba(49, 84, 216, 0.62)',
    borderRadius: '2px',
    boxSizing: 'border-box',
    background: 'rgba(77, 107, 254, 0.28)',
    boxShadow: '0 0 0 2px rgba(77, 107, 254, 0.12)',
    mixBlendMode: 'multiply',
    pointerEvents: 'none',
  } as const,
  annotationMenu: {
    position: 'fixed',
    zIndex: 380,
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    minHeight: '36px',
    padding: '3px',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '9px',
    background: 'rgba(255,255,255,0.98)',
    color: '#262626',
    boxShadow: '0 4px 14px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.08)',
    backdropFilter: 'blur(10px)',
    boxSizing: 'border-box',
  } as const,
  annotationHighlightAction: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'stretch',
    height: '30px',
    borderRadius: '6px',
    overflow: 'visible',
  } as const,
  annotationHighlightButton: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '30px',
    padding: 0,
    border: 'none',
    borderRadius: '6px 0 0 6px',
    background: 'transparent',
    color: '#3f3f46',
    cursor: 'pointer',
  } as const,
  annotationHighlightIndicator: {
    position: 'absolute',
    left: '7px',
    right: '7px',
    bottom: '2px',
    height: '3px',
    borderRadius: '2px',
  } as const,
  annotationPaletteButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '30px',
    padding: 0,
    border: 'none',
    borderLeft: '1px solid rgba(0,0,0,0.07)',
    borderRadius: '0 6px 6px 0',
    background: 'transparent',
    color: '#71717a',
    cursor: 'pointer',
  } as const,
  annotationPalette: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: 0,
    display: 'flex',
    gap: '4px',
    padding: '5px',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '9px',
    background: '#fff',
    boxShadow: '0 4px 14px rgba(0,0,0,0.16)',
  } as const,
  annotationColorButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    padding: 0,
    border: '1.5px solid transparent',
    borderRadius: '7px',
    background: 'transparent',
    cursor: 'pointer',
  } as const,
  annotationColorSwatch: {
    display: 'block',
    width: '17px',
    height: '17px',
    borderRadius: '50%',
    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.1)',
  } as const,
  annotationMenuDivider: {
    width: '1px',
    height: '22px',
    margin: '0 1px',
    background: 'rgba(0,0,0,0.1)',
  } as const,
  annotationDeleteButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '30px',
    height: '30px',
    padding: 0,
    border: 'none',
    borderRadius: '7px',
    background: 'transparent',
    color: '#71717a',
    cursor: 'pointer',
  } as const,
  annotationNoteButton: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '30px',
    height: '30px',
    padding: 0,
    border: 'none',
    borderRadius: '7px',
    background: 'transparent',
    color: '#71717a',
    cursor: 'pointer',
  } as const,
  annotationAiButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    height: '30px',
    padding: '0 8px',
    border: 'none',
    borderRadius: '7px',
    background: 'rgba(77,107,254,0.11)',
    color: '#3154d8',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 650,
    lineHeight: 1,
  } as const,
  annotationAiAction: {
    position: 'relative',
    display: 'inline-flex',
  } as const,
  annotationAiMenu: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    width: '224px',
    padding: '5px',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '10px',
    background: '#fff',
    boxShadow: '0 5px 18px rgba(0,0,0,0.18)',
    boxSizing: 'border-box',
  } as const,
  annotationAiMenuItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    width: '100%',
    gap: '2px',
    padding: '7px 9px',
    border: 'none',
    borderRadius: '7px',
    background: 'transparent',
    color: '#27272a',
    cursor: 'pointer',
    textAlign: 'left',
  } as const,
  annotationAiMenuLabel: {
    fontSize: '12px',
    fontWeight: 600,
    lineHeight: 1.3,
  } as const,
  annotationAiMenuHint: {
    color: '#8a8a93',
    fontSize: '10px',
    lineHeight: 1.35,
  } as const,
  annotationAiQuestionEditor: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    width: '292px',
    padding: '10px',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '10px',
    background: '#fff',
    boxShadow: '0 5px 18px rgba(0,0,0,0.18)',
    boxSizing: 'border-box',
  } as const,
  annotationAiQuestionTitle: {
    marginBottom: '7px',
    color: '#27272a',
    fontSize: '12px',
    fontWeight: 600,
  } as const,
  imageAiMenu: {
    position: 'fixed',
    zIndex: 1300,
    width: '238px',
    padding: '5px',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '11px',
    background: 'rgba(255,255,255,0.99)',
    boxShadow: '0 7px 24px rgba(0,0,0,0.2)',
    boxSizing: 'border-box',
  } as const,
  imageAiHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: '28px',
    padding: '1px 4px 3px 9px',
    color: '#3154d8',
    fontSize: '11px',
    fontWeight: 650,
  } as const,
  imageAiClose: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    padding: 0,
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: '#8a8a93',
    cursor: 'pointer',
    fontSize: '16px',
  } as const,
  annotationStrokeAction: {
    position: 'relative',
    display: 'inline-flex',
  } as const,
  annotationStrokePalette: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    gap: '4px',
    padding: '5px',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '9px',
    background: 'rgba(255,255,255,0.99)',
    boxShadow: '0 4px 14px rgba(0,0,0,0.16)',
  } as const,
  annotationStrokeOption: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '34px',
    height: '28px',
    padding: 0,
    border: '1.5px solid transparent',
    borderRadius: '7px',
    background: 'transparent',
    color: '#52525b',
    cursor: 'pointer',
  } as const,
  annotationStrokeSample: {
    display: 'block',
    width: '18px',
    borderRadius: '2px',
  } as const,
  annotationNoteIndicator: {
    position: 'absolute',
    top: '4px',
    right: '4px',
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    background: '#4d6bfe',
    boxShadow: '0 0 0 1.5px #fff',
  } as const,
  annotationNoteEditor: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    width: '260px',
    padding: '10px',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '10px',
    background: 'rgba(255,255,255,0.99)',
    boxShadow: '0 5px 18px rgba(0,0,0,0.18)',
    boxSizing: 'border-box',
  } as const,
  annotationNoteTextarea: {
    display: 'block',
    width: '100%',
    minHeight: '76px',
    maxHeight: '180px',
    resize: 'vertical',
    padding: '8px 9px',
    border: '1px solid #d4d4d8',
    borderRadius: '7px',
    outline: 'none',
    background: '#fff',
    color: '#27272a',
    font: 'inherit',
    fontSize: '12px',
    lineHeight: 1.5,
    boxSizing: 'border-box',
  } as const,
  annotationNoteFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    marginTop: '8px',
  } as const,
  annotationNoteCount: {
    color: '#a1a1aa',
    fontSize: '10px',
    fontVariantNumeric: 'tabular-nums',
  } as const,
  annotationNoteActions: {
    display: 'flex',
    gap: '6px',
  } as const,
  annotationNoteAction: {
    height: '26px',
    padding: '0 9px',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: '#52525b',
    cursor: 'pointer',
    fontSize: '11px',
  } as const,
  annotationNoteSave: {
    background: '#4d6bfe',
    color: '#fff',
  } as const,
  unsavedBadge: {
    flex: '0 0 auto',
    padding: '2px 6px',
    borderRadius: '8px',
    background: 'rgba(250,173,20,0.15)',
    color: '#ad6800',
    fontSize: '10px',
    lineHeight: '14px',
  } as const,
  selectionNumber: {
    position: 'absolute',
    top: '2px',
    left: '2px',
    minWidth: '18px',
    height: '18px',
    padding: '0 4px',
    borderRadius: '9px',
    boxSizing: 'border-box',
    background: '#4d6bfe',
    color: '#fff',
    fontSize: '11px',
    lineHeight: '18px',
    textAlign: 'center',
    boxShadow: '0 1px 3px rgba(0,0,0,0.22)',
  } as const,
  selectionNumberButton: {
    border: 'none',
    cursor: 'pointer',
    pointerEvents: 'auto',
    fontFamily: 'inherit',
  } as const,
  evidenceSelectionNumber: {
    background: '#7c5cff',
  } as const,
  selectionRemove: {
    position: 'absolute',
    top: '2px',
    right: '2px',
    width: '18px',
    height: '18px',
    padding: 0,
    border: 'none',
    borderRadius: '9px',
    background: 'rgba(38,38,38,0.82)',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '14px',
    lineHeight: '18px',
    textAlign: 'center',
    pointerEvents: 'auto',
    boxShadow: '0 1px 3px rgba(0,0,0,0.22)',
  } as const,
  selectionMenuAnchor: {
    position: 'relative',
  } as const,
  rotationMenu: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    right: 0,
    zIndex: 20,
    minWidth: '210px',
    padding: '6px',
    boxSizing: 'border-box',
    border: '1px solid #d9d9d9',
    borderRadius: '8px',
    background: '#fff',
    color: '#262626',
    boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
  } as const,
  rotationMenuItem: {
    width: '100%',
    padding: '7px 8px',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '12px',
    textAlign: 'left',
    whiteSpace: 'nowrap',
  } as const,
  rotationMenuDivider: {
    height: '1px',
    margin: '5px 4px',
    background: '#eee',
  } as const,
  selectionMenu: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    zIndex: 20,
    minWidth: '230px',
    maxHeight: '280px',
    overflowY: 'auto',
    padding: '6px',
    boxSizing: 'border-box',
    border: '1px solid #d9d9d9',
    borderRadius: '8px',
    background: '#fff',
    color: '#262626',
    boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
  } as const,
  selectionMenuRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  } as const,
  selectionMenuJump: {
    flex: 1,
    minWidth: 0,
    padding: '6px 8px',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: '12px',
    textAlign: 'left',
    whiteSpace: 'nowrap',
  } as const,
  selectionMenuRemove: {
    flex: '0 0 auto',
    width: '26px',
    height: '26px',
    padding: 0,
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: '#8c8c8c',
    cursor: 'pointer',
    fontSize: '15px',
  } as const,
  selectionMenuClear: {
    width: '100%',
    marginTop: '6px',
    padding: '6px 8px',
    border: 'none',
    borderTop: '1px solid #eee',
    background: 'transparent',
    color: '#d4380d',
    cursor: 'pointer',
    fontSize: '12px',
    textAlign: 'left',
  } as const,
  widePanel: {
    position: 'fixed',
    left: 0,
    top: 0,
    bottom: 0,
    zIndex: 300,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    // The panel is a WHITE reading surface (PDF pages are white), regardless
    // of the app theme: declare it, or the portal inherits the app's text
    // color and everything turns light-on-white (invisible input text).
    colorScheme: 'light',
    color: '#262626',
    background: 'var(--dsw-alias-bg-primary, #fff)',
    padding: '12px',
    boxSizing: 'border-box',
    boxShadow: '4px 0 24px rgba(0,0,0,0.18)',
    overflow: 'hidden',
  } as const,
  wideResizeHandle: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: '6px',
    cursor: 'col-resize',
  } as const,
  widePlaceholder: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    color: 'var(--dsw-alias-content-tertiary, #999)',
    fontSize: '12px',
  } as const,
} satisfies Record<string, CSSProperties>

type PdfToolbarButtonProps = Omit<
ButtonHTMLAttributes<HTMLButtonElement>,
'style' | 'onPointerEnter' | 'onPointerLeave' | 'onFocus' | 'onBlur'
> & { iconOnly?: boolean; active?: boolean }

function PdfToolbarButton({ iconOnly = false, active = false, disabled, type = 'button', ...props }: PdfToolbarButtonProps) {
  const [interactive, setInteractive] = useState(false)
  return (
    <button
      {...props}
      type={type}
      disabled={disabled}
      style={{
        ...styles.toolButton,
        ...(iconOnly ? styles.toolIconButton : {}),
        ...(interactive && !disabled ? styles.toolButtonInteractive : {}),
        ...(active && !disabled ? styles.toolButtonActive : {}),
        ...(disabled ? styles.toolButtonDisabled : {}),
      }}
      onPointerEnter={() => { setInteractive(true) }}
      onPointerLeave={(event) => {
        if (document.activeElement !== event.currentTarget) setInteractive(false)
      }}
      onFocus={() => { setInteractive(true) }}
      onBlur={() => { setInteractive(false) }}
    />
  )
}

function TextSelectPdfIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M4.5 2.5h7M8 2.5v11M5.25 13.5h5.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  )
}

function CropSelectPdfIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M6 2.75H2.75V6M10 2.75h3.25V6M13.25 10v3.25H10M6 13.25H2.75V10" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function HighlightPdfIcon() {
  return (
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 18 18" fill="none">
      <path d="m5.1 11.65 6.55-6.55a1.35 1.35 0 0 1 1.91 0l.34.34a1.35 1.35 0 0 1 0 1.91L7.35 13.9l-3.2.7.95-2.95Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
      <path d="m10.45 6.3 1.25 1.25M3.25 15.25h6.25" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  )
}

function UnderlinePdfIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M4.5 2.75v4.6a3.5 3.5 0 0 0 7 0v-4.6M3.5 13.25h9" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  )
}

function StrikeoutPdfIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M11.75 4.2c-.7-.9-1.86-1.45-3.48-1.45-1.8 0-3.12.75-3.12 2.02 0 1.2 1.08 1.64 2.95 2.08M4.3 11.45c.76 1.13 2.15 1.8 3.97 1.8 1.93 0 3.35-.8 3.35-2.13 0-1.16-.92-1.64-2.7-2.12M2.5 8h11" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

function TextMarkupPdfIcon({ kind }: { kind: PdfTextMarkupKind }) {
  if (kind === 'underline') return <UnderlinePdfIcon />
  if (kind === 'strikeout') return <StrikeoutPdfIcon />
  return <HighlightPdfIcon />
}

function ChevronDownPdfIcon() {
  return (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="m2.5 3.75 2.5 2.5 2.5-2.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DeletePdfIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3.5 4.5h9M6.25 2.75h3.5M5 4.5l.45 8h5.1l.45-8M6.75 6.5v4M9.25 6.5v4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CommentPdfIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 3.25h10v7.25H7.2L4 13v-2.5H3V3.25Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M5.25 5.75h5.5M5.25 8h3.5" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
    </svg>
  )
}

function LineWidthPdfIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 4h10" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <path d="M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M3 12h10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

function CopyPdfIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="5.25" y="5.25" width="7.5" height="7.5" rx="1.25" stroke="currentColor" strokeWidth="1.25" />
      <path d="M10.5 5.25V4.5a1.25 1.25 0 0 0-1.25-1.25H4.5A1.25 1.25 0 0 0 3.25 4.5v4.75A1.25 1.25 0 0 0 4.5 10.5h.75" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

function CheckPdfIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="m3.25 8.25 3 3 6.5-6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PdfAiSparkleIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M7.25 2.25c.35 2.45 1.55 3.65 4 4-2.45.35-3.65 1.55-4 4-.35-2.45-1.55-3.65-4-4 2.45-.35 3.65-1.55 4-4Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M12.25 10.25c.15 1.05.7 1.6 1.75 1.75-1.05.15-1.6.7-1.75 1.75-.15-1.05-.7-1.6-1.75-1.75 1.05-.15 1.6-.7 1.75-1.75Z" fill="currentColor" />
    </svg>
  )
}

function PdfDocumentIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3.25 1.75h5.5l3.75 3.75v8.75h-9.25z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M8.75 1.75V5.5h3.75" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M5.5 8h4.75M5.5 10.5h4.75" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
    </svg>
  )
}

function ReplacePdfIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M1.5 4V2.75h4l1.4 1.5h5.6V5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 5.5h10.5l-1.25 5.75h-8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

function SavePdfIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M2.5 2.25h8.25l2.75 2.75v8.75h-11z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M5 2.75v3.5h5v-3.5M5 13.25V9h6v4.25" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

function BookmarkPdfIcon({ filled }: { filled: boolean }) {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M4 2.25h8v11.5L8 11.15l-4 2.6V2.25Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ClosePdfIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M3.25 3.25 12.75 12.75M12.75 3.25 3.25 12.75" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  )
}

function RotatePdfIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M12.75 5.25V2.5m0 0H10m2.75 0-2.1 2.1A5.25 5.25 0 1 0 13.2 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function FitPdfIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M5.25 2.5H2.5v2.75M10.75 2.5h2.75v2.75M13.5 10.75v2.75h-2.75M5.25 13.5H2.5v-2.75" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="5" y="4" width="6" height="8" rx="0.8" stroke="currentColor" strokeWidth="1.15" />
    </svg>
  )
}

function ThumbnailPdfIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="4.25" height="5" rx="0.7" stroke="currentColor" strokeWidth="1.15" />
      <rect x="9.75" y="2" width="4.25" height="5" rx="0.7" stroke="currentColor" strokeWidth="1.15" />
      <rect x="2" y="9" width="4.25" height="5" rx="0.7" stroke="currentColor" strokeWidth="1.15" />
      <rect x="9.75" y="9" width="4.25" height="5" rx="0.7" stroke="currentColor" strokeWidth="1.15" />
    </svg>
  )
}

function AnnotationListPdfIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none">
      <path d="M3 2.5h10v11H3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M5.25 5.25h5.5M5.25 8h5.5M5.25 10.75h3.25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M3 2.5h2v11H3z" fill="currentColor" opacity="0.16" />
    </svg>
  )
}

function CollapsePdfPanelIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2.25" width="12" height="11.5" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5.25 2.75v10.5M10 5.5 7.5 8l2.5 2.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

interface PositionedTextItem {
  str: string
  dir?: string
  transform: readonly number[]
  width: number
  height: number
}

function isPositionedTextItem(value: unknown): value is PositionedTextItem {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<PositionedTextItem>
  return typeof candidate.str === 'string'
    && Array.isArray(candidate.transform)
    && candidate.transform.length >= 6
    && candidate.transform.every(Number.isFinite)
    && typeof candidate.width === 'number'
    && Number.isFinite(candidate.width)
    && typeof candidate.height === 'number'
    && Number.isFinite(candidate.height)
}

/** Approximate one clicked hit with bounded, axis-aligned text-fragment boxes. */
function pdfSearchHighlightRects(
  page: PDFPageProxy,
  items: readonly unknown[],
  result: PdfSearchResult,
  rotation: PdfPageRotation,
): readonly Rect[] {
  const viewport = page.getViewport({
    scale: 1,
    rotation: normalizePdfRotation(page.rotate + rotation),
  })
  return pdfSearchHighlightSlices(items, result).flatMap((slice) => {
    const item = items[slice.itemIndex]
    if (!isPositionedTextItem(item)) return []
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = item.transform
    const [baseX = 0, baseY = 0] = viewport.convertToViewportPoint(e, f) as number[]
    const [alongX = 0, alongY = 0] = viewport.convertToViewportPoint(e + a, f + b) as number[]
    const [topX = 0, topY = 0] = viewport.convertToViewportPoint(e + c, f + d) as number[]
    const directionLength = Math.hypot(alongX - baseX, alongY - baseY)
    if (directionLength <= 0 || item.width <= 0) return []
    const directionX = (alongX - baseX) / directionLength
    const directionY = (alongY - baseY) / directionLength
    const topLength = Math.hypot(topX - baseX, topY - baseY)
    const topDirectionX = topLength > 0 ? (topX - baseX) / topLength : directionY
    const topDirectionY = topLength > 0 ? (topY - baseY) / topLength : -directionX
    const height = Math.max(1, item.height, topLength)
    const startRatio = item.dir === 'rtl' ? 1 - slice.endRatio : slice.startRatio
    const endRatio = item.dir === 'rtl' ? 1 - slice.startRatio : slice.endRatio
    const startDistance = item.width * startRatio
    const endDistance = item.width * endRatio
    const startX = baseX + directionX * startDistance
    const startY = baseY + directionY * startDistance
    const endX = baseX + directionX * endDistance
    const endY = baseY + directionY * endDistance
    const corners = [
      [startX, startY],
      [endX, endY],
      [startX + topDirectionX * height, startY + topDirectionY * height],
      [endX + topDirectionX * height, endY + topDirectionY * height],
    ]
    const xs = corners.map(corner => corner[0] ?? 0)
    const ys = corners.map(corner => corner[1] ?? 0)
    const left = Math.min(...xs)
    const top = Math.min(...ys)
    const width = Math.max(2, Math.max(...xs) - left)
    const boxHeight = Math.max(2, Math.max(...ys) - top)
    const horizontalPadding = Math.min(1.5, Math.max(0.75, boxHeight * 0.15))
    const verticalPadding = Math.min(2.5, Math.max(1.5, boxHeight * 0.22))
    // PDF text transforms describe the font em box, whose visual center sits
    // slightly above most glyphs. Bias the decoration down without changing
    // its height so it reads as centered on the ink, not near the line above.
    const visualCenterOffset = Math.min(1.75, Math.max(1, boxHeight * 0.16))
    return [{
      x: left - horizontalPadding,
      y: top - verticalPadding + visualCenterOffset,
      width: width + horizontalPadding * 2,
      height: boxHeight + verticalPadding * 2,
    }]
  })
}

/** One page: canvas paint, selection-box overlay, and the committed-box marker. */
const PdfPage = memo(function PdfPage(props: {
  doc: PDFDocumentProxy
  pageNumber: number
  /** Clockwise view-only rotation relative to the PDF page's intrinsic direction. */
  rotation: PdfPageRotation
  /** Stable fit-width scale; user zoom is applied once by the page-list parent. */
  layoutScale: number
  /** Debounced scale for the actual pdf.js repaint. */
  renderScale: number
  /** Previously measured natural size, retained while this page is virtualized out. */
  knownSize: PageSize | undefined
  committedSelections: readonly { selection: SelectionInfo; order: number; destination: 'composer' | 'evidence' }[]
  annotations: readonly PdfTextMarkupAnnotation[]
  evidenceRects: readonly Rect[]
  evidenceImage: PdfCitationImageTarget | undefined
  evidenceHighlightRevision: number
  onSize: (pageNumber: number, size: PageSize) => void
  onSelect: (selection: SelectionInfo, anchor: ClientRectSnapshot) => void
  onSelectionRemove: (selection: SelectionInfo) => void
  onSelectionActivate: (selection: SelectionInfo, anchor: ClientRectSnapshot) => void
  onEvidenceImageRemove: (selection: SelectionInfo) => void
  onSelectionError: (message: string) => void
  interactionMode: PdfInteractionMode
  onTextUnavailable: (pageNumber: number) => void
  onAnnotationActivate: (annotation: PdfTextMarkupAnnotation, anchor: ClientRectSnapshot) => void
  imageLimits: ComposerImageLimits | undefined
  searchHighlight: ActivePdfSearchHit | undefined
  /** Bounded recent-page placeholder restored before pdf.js repaints. */
  pagePreview: HTMLCanvasElement | undefined
  retainPreview: boolean
  onPagePaint: (pageNumber: number, canvas: HTMLCanvasElement) => void
  /** One serial repaint turn: current page first, then nearby pages. */
  repaintKey: string
  repaintOrder: number
  repaintAllowed: boolean
  onRepaintSettled: (key: string, order: number) => void
}) {
  const { doc, pageNumber, layoutScale, renderScale, rotation } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const textLayerTaskRef = useRef<TextLayer | undefined>(undefined)
  const [page, setPage] = useState<PDFPageProxy | undefined>(undefined)
  const [textContent, setTextContent] = useState<PdfTextContent | undefined>(undefined)
  const [size, setSize] = useState<PageSize | undefined>(props.knownSize)
  const [drag, setDrag] = useState<{ pointerId: number; start: Point; current: Point } | undefined>(undefined)
  const [pageError, setPageError] = useState<string | undefined>(undefined)
  const [painted, setPainted] = useState(false)
  const [searchHighlightRects, setSearchHighlightRects] = useState<readonly Rect[]>([])
  const [textSelectionRects, setTextSelectionRects] = useState<readonly Rect[]>([])
  const firstSearchHighlightRef = useRef<HTMLDivElement>(null)
  const centeredSearchHighlightRef = useRef<string | undefined>(undefined)
  const renderTask = useRef<RenderTask | undefined>(undefined)
  const committedRenderScaleRef = useRef<number | undefined>(undefined)
  const committedRotationRef = useRef<PdfPageRotation | undefined>(undefined)
  const paintedRef = useRef(false)

  const hasSelectableText = useMemo(() => textContent === undefined
    ? undefined
    : textContent.items.some(item => 'str' in item && item.str.trim().length > 0), [textContent])

  // A cached bitmap from another orientation is misleading and cannot be
  // cropped safely. Blank it synchronously while the rotated repaint stages.
  useLayoutEffect(() => {
    if (committedRotationRef.current === undefined || committedRotationRef.current === rotation) return
    renderTask.current?.cancel()
    const canvas = canvasRef.current
    if (canvas !== null) {
      canvas.width = 1
      canvas.height = 1
    }
    committedRenderScaleRef.current = undefined
    committedRotationRef.current = undefined
    paintedRef.current = false
    setPainted(false)
  }, [rotation])

  // A distant jump remounts a recent page with no backing store. Restore its
  // bounded preview before the browser paints this commit; the real pdf.js
  // render still owns `painted`, so selection never reads placeholder pixels.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const preview = props.pagePreview
    if (canvas === null || committedRenderScaleRef.current !== undefined
      || preview === undefined || preview.width <= 1 || preview.height <= 1) return
    canvas.width = preview.width
    canvas.height = preview.height
    const context = canvas.getContext('2d')
    if (context === null) return
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(preview, 0, 0)
    canvas.dataset['pdfPreview'] = 'true'
  }, [props.pagePreview])

  // Natural size and the page proxy, once per mounted page-window visit.
  useEffect(() => {
    let cancelled = false
    let loadedPage: PDFPageProxy | undefined
    void doc.getPage(pageNumber).then((loaded) => {
      if (cancelled) {
        loaded.cleanup()
        return
      }
      loadedPage = loaded
      setPage(loaded)
      const viewport = loaded.getViewport({ scale: 1 })
      const nextSize = { width: viewport.width, height: viewport.height }
      setSize(nextSize)
      props.onSize(pageNumber, nextSize)
    }).catch((cause: unknown) => {
      if (!cancelled) setPageError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      cancelled = true
      // The document may cache the proxy, but decoded graphics/operator data
      // should not grow with every page the user has ever visited.
      loadedPage?.cleanup()
    }
  }, [doc, pageNumber, props.onSize])

  // Resize before DOM removal so Chromium can release the raster backing store
  // immediately instead of waiting for a later garbage-collection cycle.
  useEffect(() => () => {
    const canvas = canvasRef.current
    if (canvas !== null) {
      canvas.width = 1
      canvas.height = 1
    }
    textLayerRef.current?.replaceChildren()
  }, [])

  // A real pdf.js text layer restores standard browser text selection. The
  // extracted content is retained for this bounded page mount and also reused
  // by search-hit geometry instead of issuing a second extraction request.
  useEffect(() => {
    if (page === undefined) {
      setTextContent(undefined)
      return
    }
    let cancelled = false
    setTextContent(undefined)
    void page.getTextContent().then((content) => {
      if (!cancelled) setTextContent(content)
    }).catch(() => {
      if (!cancelled) setTextContent({ items: [], styles: {}, lang: null })
    })
    return () => { cancelled = true }
  }, [page])

  useEffect(() => {
    const container = textLayerRef.current
    if (container === null || page === undefined || textContent === undefined) return
    textLayerTaskRef.current?.cancel()
    container.replaceChildren()
    const viewport = page.getViewport({
      scale: layoutScale,
      rotation: normalizePdfRotation(page.rotate + rotation),
    })
    const task = new TextLayer({ textContentSource: textContent, container, viewport })
    textLayerTaskRef.current = task
    void task.render().catch(() => {})
    return () => {
      task.cancel()
      if (textLayerTaskRef.current === task) textLayerTaskRef.current = undefined
      container.replaceChildren()
    }
  }, [page, rotation, textContent])

  useEffect(() => {
    if (props.interactionMode !== 'crop') setDrag(undefined)
  }, [props.interactionMode])

  const updateTextSelectionRects = useCallback((): void => {
    const layer = textLayerRef.current
    const selection = window.getSelection()
    if (props.interactionMode !== 'text' || layer === null || selection === null || selection.isCollapsed) {
      setTextSelectionRects([])
      return
    }
    const layerBox = layer.getBoundingClientRect()
    if (layerBox.width <= 0 || layerBox.height <= 0 || layer.clientWidth <= 0 || layer.clientHeight <= 0) {
      setTextSelectionRects([])
      return
    }
    const scaleX = layer.clientWidth / layerBox.width
    const scaleY = layer.clientHeight / layerBox.height
    const fragments: Rect[] = []
    for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
      const range = selection.getRangeAt(rangeIndex)
      try {
        if (!range.intersectsNode(layer)) continue
      } catch {
        continue
      }
      for (const fragment of range.getClientRects()) {
        const left = Math.max(fragment.left, layerBox.left)
        const top = Math.max(fragment.top, layerBox.top)
        const right = Math.min(fragment.right, layerBox.right)
        const bottom = Math.min(fragment.bottom, layerBox.bottom)
        if (right <= left || bottom <= top) continue
        fragments.push({
          x: (left - layerBox.left) * scaleX,
          y: (top - layerBox.top) * scaleY,
          width: (right - left) * scaleX,
          height: (bottom - top) * scaleY,
        })
      }
    }
    setTextSelectionRects(mergePdfTextSelectionRects(fragments))
  }, [props.interactionMode])

  useEffect(() => {
    document.addEventListener('selectionchange', updateTextSelectionRects)
    window.addEventListener('resize', updateTextSelectionRects)
    updateTextSelectionRects()
    return () => {
      document.removeEventListener('selectionchange', updateTextSelectionRects)
      window.removeEventListener('resize', updateTextSelectionRects)
    }
  }, [updateTextSelectionRects])

  useLayoutEffect(() => {
    updateTextSelectionRects()
  }, [layoutScale, rotation, updateTextSelectionRects])

  // The actual paint. Runs on the DEBOUNCED renderScale and only on this
  // page's serial repaint turn — mid-gesture ticks never touch the canvas.
  // Render off-DOM first, then replace the visible backing store only after
  // completion, so the old bitmap remains available (CSS-stretched) while a
  // sharper copy is prepared. This also prevents five large canvases from
  // reallocating and rasterizing in the same main-thread burst.
  useEffect(() => {
    if (!props.repaintAllowed) return
    const canvas = canvasRef.current
    if (canvas === null || page === undefined || size === undefined) return
    if (committedRenderScaleRef.current === renderScale && committedRotationRef.current === rotation) {
      props.onRepaintSettled(props.repaintKey, props.repaintOrder)
      return
    }
    let cancelled = false
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const paintScale = constrainedPaintScale(size.width, size.height, renderScale * dpr)
    if (committedRenderScaleRef.current === undefined) {
      paintedRef.current = false
      setPainted(false)
    }
    setPageError(undefined)
    const viewport = page.getViewport({
      scale: paintScale,
      rotation: normalizePdfRotation(page.rotate + rotation),
    })
    const staging = document.createElement('canvas')
    staging.width = Math.floor(viewport.width)
    staging.height = Math.floor(viewport.height)
    const context = staging.getContext('2d')
    if (context === null) {
      props.onRepaintSettled(props.repaintKey, props.repaintOrder)
      return
    }
    renderTask.current?.cancel()
    const task = page.render({ canvas: staging, canvasContext: context, viewport })
    renderTask.current = task
    void task.promise.then(() => {
      if (cancelled) return
      canvas.width = staging.width
      canvas.height = staging.height
      const visibleContext = canvas.getContext('2d')
      if (visibleContext === null) throw new Error('无法更新 PDF 页面画布')
      visibleContext.drawImage(staging, 0, 0)
      committedRenderScaleRef.current = renderScale
      committedRotationRef.current = rotation
      canvas.dataset['pdfRenderScale'] = String(renderScale)
      canvas.dataset['pdfRotation'] = String(rotation)
      delete canvas.dataset['pdfPreview']
      paintedRef.current = true
      if (props.retainPreview) props.onPagePaint(pageNumber, canvas)
      setPainted(true)
    }).catch((cause: unknown) => {
      // RenderTask.cancel() rejects with RenderingCancelledException — benign.
      if (cause instanceof Error && cause.name === 'RenderingCancelledException') return
      if (!cancelled) setPageError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      staging.width = 1
      staging.height = 1
      if (!cancelled) {
        renderTask.current = undefined
        props.onRepaintSettled(props.repaintKey, props.repaintOrder)
      }
    })
    return () => {
      cancelled = true
      renderTask.current?.cancel()
      renderTask.current = undefined
      staging.width = 1
      staging.height = 1
    }
  }, [page, pageNumber, props.onPagePaint, props.onRepaintSettled, props.repaintAllowed, props.repaintKey, props.repaintOrder, props.retainPreview, renderScale, rotation, size])

  // Only pages the user actually reads enter the LRU. If a prefetched
  // neighbor later becomes current, its already-painted canvas is admitted
  // without forcing another pdf.js render.
  useEffect(() => {
    if (!props.retainPreview || !paintedRef.current) return
    const canvas = canvasRef.current
    if (canvas !== null) props.onPagePaint(pageNumber, canvas)
  }, [pageNumber, props.onPagePaint, props.retainPreview])

  // A malformed page can fail before a render task exists. It must still
  // release its serial turn so neighboring pages are not starved forever.
  useEffect(() => {
    if (props.repaintAllowed && page === undefined && pageError !== undefined) {
      props.onRepaintSettled(props.repaintKey, props.repaintOrder)
    }
  }, [page, pageError, props.onRepaintSettled, props.repaintAllowed, props.repaintKey, props.repaintOrder])

  useEffect(() => {
    if (page === undefined || textContent === undefined || props.searchHighlight === undefined) {
      setSearchHighlightRects([])
      return
    }
    setSearchHighlightRects([])
    setSearchHighlightRects(pdfSearchHighlightRects(page, textContent.items, props.searchHighlight.result, rotation))
  }, [page, props.searchHighlight, rotation, textContent])

  // The page jump mounts the target page first; center the exact occurrence
  // once its text coordinates arrive, then leave normal user scrolling alone.
  useLayoutEffect(() => {
    const hit = props.searchHighlight
    if (hit === undefined || searchHighlightRects.length === 0) return
    const key = `${hit.query}:${String(hit.result.pageNumber)}:${String(hit.result.offset)}:${String(rotation)}`
    if (centeredSearchHighlightRef.current === key) return
    centeredSearchHighlightRef.current = key
    firstSearchHighlightRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [props.searchHighlight, rotation, searchHighlightRects])

  const overlayPoint = (event: ReactPointerEvent<HTMLDivElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect()
    const localWidth = event.currentTarget.clientWidth
    const localHeight = event.currentTarget.clientHeight
    return {
      x: Math.min(localWidth, Math.max(0, (event.clientX - box.left) * localWidth / box.width)),
      y: Math.min(localHeight, Math.max(0, (event.clientY - box.top) * localHeight / box.height)),
    }
  }

  const encodeCrop = (canvas: HTMLCanvasElement, rect: Rect, ratio: number): string => {
    const sourceWidth = Math.max(1, Math.round(rect.width * ratio))
    const sourceHeight = Math.max(1, Math.round(rect.height * ratio))
    const maxPixels = props.imageLimits?.maxImagePixels ?? sourceWidth * sourceHeight
    let target = fitWithinPixels(sourceWidth, sourceHeight, maxPixels)
    const maxBytes = props.imageLimits?.maxImageBytes ?? Number.MAX_SAFE_INTEGER
    const crop = document.createElement('canvas')

    for (let attempt = 0; attempt < 10; attempt += 1) {
      crop.width = target.width
      crop.height = target.height
      const context = crop.getContext('2d')
      if (context === null) throw new Error('无法创建选区截图画布')
      context.drawImage(
        canvas,
        rect.x * ratio, rect.y * ratio, rect.width * ratio, rect.height * ratio,
        0, 0, target.width, target.height,
      )
      const pngBase64 = crop.toDataURL('image/png').split(',')[1] ?? ''
      const bytes = base64ByteLength(pngBase64)
      if (pngBase64.length > 0 && bytes <= maxBytes) return pngBase64
      if (target.width === 1 && target.height === 1) break
      const shrink = bytes > 0 ? Math.min(0.8, Math.sqrt(maxBytes / bytes) * 0.92) : 0.8
      target = {
        width: Math.max(1, Math.floor(target.width * shrink)),
        height: Math.max(1, Math.floor(target.height * shrink)),
      }
    }
    throw new Error('选区截图超过当前会话的图片上限，请缩小选区后重试')
  }

  /** Crop the committed box out of the canvas for the host composer. */
  const commitSelection = (rect: Rect): void => {
    const canvas = canvasRef.current
    if (canvas === null || page === undefined || !painted) return
    const ratio = canvas.width / canvas.clientWidth
    try {
      const pngBase64 = encodeCrop(canvas, rect, ratio)
      const normalizedRect = {
        x: rect.x / canvas.clientWidth,
        y: rect.y / canvas.clientHeight,
        width: rect.width / canvas.clientWidth,
        height: rect.height / canvas.clientHeight,
      }
      const canvasBounds = canvas.getBoundingClientRect()
      const anchor = snapshotClientRect({
        left: canvasBounds.left + normalizedRect.x * canvasBounds.width,
        top: canvasBounds.top + normalizedRect.y * canvasBounds.height,
        right: canvasBounds.left + (normalizedRect.x + normalizedRect.width) * canvasBounds.width,
        bottom: canvasBounds.top + (normalizedRect.y + normalizedRect.height) * canvasBounds.height,
        width: normalizedRect.width * canvasBounds.width,
        height: normalizedRect.height * canvasBounds.height,
      })
      props.onSelect({ pageNumber, rect: normalizedRect, rotation, pngBase64 }, anchor)
    } catch (cause) {
      props.onSelectionError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  // NOTE: no rounding here — a floored base height gets AMPLIFIED by the
  // gesture transform (≈1px × zoom × page-count of accumulated settle-swap
  // discontinuity, the pinch-anchor drift). Fractional CSS px are fine.
  const activeRect = drag !== undefined ? normalizeRect(drag.start, drag.current) : undefined
  return (
    <>
      <canvas ref={canvasRef} style={{ ...styles.page, width: '100%', height: '100%' }} />
      <div
        ref={textLayerRef}
        data-pdf-text-layer="true"
        data-pdf-has-text={hasSelectableText === undefined ? 'loading' : String(hasSelectableText)}
        data-pdf-interaction-mode={props.interactionMode}
        style={{
          ...styles.textLayer,
          '--total-scale-factor': String(layoutScale),
          '--scale-round-x': '1px',
          '--scale-round-y': '1px',
          pointerEvents: props.interactionMode === 'text' ? 'auto' : 'none',
          userSelect: props.interactionMode === 'text' ? 'text' : 'none',
        } as CSSProperties}
        onPointerDown={() => {
          if (props.interactionMode === 'text' && hasSelectableText === false) {
            props.onTextUnavailable(pageNumber)
          }
        }}
      />
      <div
        data-pdf-selection-layer="true"
        data-pdf-interaction-mode={props.interactionMode}
        style={{
          ...styles.selectLayer,
          pointerEvents: props.interactionMode === 'crop' ? 'auto' : 'none',
        }}
        onPointerDown={(event) => {
          if (props.interactionMode !== 'crop' || event.button !== 0 || event.pointerType === 'touch' || !painted) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          const point = overlayPoint(event)
          setDrag({ pointerId: event.pointerId, start: point, current: point })
        }}
        onPointerMove={(event) => {
          if (drag === undefined || drag.pointerId !== event.pointerId) return
          setDrag({ ...drag, current: overlayPoint(event) })
        }}
        onPointerUp={(event) => {
          if (drag === undefined || drag.pointerId !== event.pointerId) return
          const rect = normalizeRect(drag.start, drag.current)
          setDrag(undefined)
          if (rect.width < 4 || rect.height < 4) return
          commitSelection(rect)
        }}
        onPointerCancel={(event) => {
          if (drag?.pointerId === event.pointerId) setDrag(undefined)
        }}
      >
        {textSelectionRects.map((rect, index) => (
          <div
            key={`text:${String(index)}`}
            data-pdf-text-selection-highlight="true"
            aria-hidden="true"
            style={{
              ...styles.textSelectionHighlight,
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
            }}
          />
        ))}
        {searchHighlightRects.map((rect, index) => (
          <div
            key={index}
            ref={index === 0 ? firstSearchHighlightRef : undefined}
            data-pdf-search-highlight="true"
            aria-hidden="true"
            style={{
              ...styles.searchHighlight,
              left: rect.x * layoutScale,
              top: rect.y * layoutScale,
              width: rect.width * layoutScale,
              height: rect.height * layoutScale,
            }}
          />
        ))}
        {activeRect !== undefined && (
          <div style={{
            ...styles.selectionBox,
            left: activeRect.x, top: activeRect.y,
            width: activeRect.width, height: activeRect.height,
          }} />
        )}
        {props.committedSelections.map(({ selection, order, destination }) => {
          const rect = rotateNormalizedPdfRect(
            selection.rect,
            normalizePdfRotation(rotation - selection.rotation),
          )
          const evidence = destination === 'evidence'
          return <div
            key={`${destination}:${String(order)}`}
            data-pdf-selection-destination={destination}
            style={{
            ...styles.selectionBox,
            ...(evidence ? styles.evidenceSelectionBox : {}),
            left: `${String(rect.x * 100)}%`,
            top: `${String(rect.y * 100)}%`,
            width: `${String(rect.width * 100)}%`,
            height: `${String(rect.height * 100)}%`,
          }}>
            {evidence ? (
              <span aria-hidden="true" style={{
                ...styles.selectionNumber,
                ...styles.evidenceSelectionNumber,
              }}>资{String(order)}</span>
            ) : (
              <button
                type="button"
                aria-label={`打开对话图片 ${String(order)} 操作`}
                title="打开图片操作"
                style={{ ...styles.selectionNumber, ...styles.selectionNumberButton }}
                onPointerDown={(event) => { event.stopPropagation() }}
                onClick={(event) => {
                  event.stopPropagation()
                  const box = event.currentTarget.parentElement
                  if (box !== null) props.onSelectionActivate(selection, snapshotClientRect(box.getBoundingClientRect()))
                }}
              >对{String(order)}</button>
            )}
            <button
              type="button"
              aria-label={`${evidence ? '删除资料图片' : '删除对话图片'} ${String(order)}`}
              title={evidence ? '从图文资料删除' : '从对话框删除'}
              style={styles.selectionRemove}
              onPointerDown={(event) => { event.stopPropagation() }}
              onClick={(event) => {
                event.stopPropagation()
                if (evidence) props.onEvidenceImageRemove(selection)
                else props.onSelectionRemove(selection)
              }}
            >
              ×
            </button>
          </div>
        })}
      </div>
      <div data-pdf-annotation-layer="true" style={styles.annotationLayer}>
        {props.evidenceRects.map((canonicalRect, index) => {
          const rect = rotateNormalizedPdfRect(canonicalRect, rotation)
          return (
            <div
              key={`${String(props.evidenceHighlightRevision)}:${String(index)}`}
              data-pdf-evidence-highlight="true"
              aria-hidden="true"
              style={{
                ...styles.evidenceHighlight,
                left: `${String(rect.x * 100)}%`,
                top: `${String(rect.y * 100)}%`,
                width: `${String(rect.width * 100)}%`,
                height: `${String(rect.height * 100)}%`,
              }}
            />
          )
        })}
        {props.evidenceImage !== undefined && (() => {
          const rect = rotateNormalizedPdfRect(
            props.evidenceImage.rect,
            normalizePdfRotation(rotation - props.evidenceImage.rotation),
          )
          return (
            <div
              key={`image:${String(props.evidenceHighlightRevision)}`}
              data-pdf-citation-image-highlight="true"
              data-pdf-evidence-highlight="true"
              aria-hidden="true"
              style={{
                ...styles.evidenceHighlight,
                left: `${String(rect.x * 100)}%`,
                top: `${String(rect.y * 100)}%`,
                width: `${String(rect.width * 100)}%`,
                height: `${String(rect.height * 100)}%`,
              }}
            />
          )
        })()}
        {props.annotations.flatMap(annotation => annotation.rects.map((canonicalRect, rectIndex) => {
          const rect = rotateNormalizedPdfRect(canonicalRect, rotation)
          const color = pdfMarkupColorOption(annotation.color)
          const kindLabel = pdfTextMarkupKindLabel(annotation.kind)
          return (
            <button
              key={`${annotation.id}:${String(rectIndex)}`}
              type="button"
              data-pdf-text-markup-annotation="true"
              data-pdf-markup-kind={annotation.kind}
              data-pdf-markup-stroke-width={annotation.strokeWidth}
              data-pdf-annotation-group={annotation.groupId}
              data-pdf-annotation-has-note={annotation.note.length > 0 ? 'true' : 'false'}
              aria-label={`打开第 ${String(pageNumber)} 页${kindLabel}批注`}
              title={annotation.note.length > 0 ? annotation.note : annotation.text.length > 0 ? annotation.text : `${kindLabel}批注`}
              style={{
                ...styles.annotationHighlight,
                left: `${String(rect.x * 100)}%`,
                top: `${String(rect.y * 100)}%`,
                width: `${String(rect.width * 100)}%`,
                height: `${String(rect.height * 100)}%`,
                ...pdfTextMarkupAppearance(annotation.kind, color, annotation.strokeWidth, layoutScale),
                pointerEvents: props.interactionMode === 'text' ? 'auto' : 'none',
              }}
              onPointerDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.stopPropagation()
                props.onAnnotationActivate(annotation, snapshotClientRect(event.currentTarget.getBoundingClientRect()))
              }}
            />
          )
        }))}
      </div>
      {pageError !== undefined && <div style={styles.pageError}>第 {pageNumber} 页渲染失败：{pageError}</div>}
    </>
  )
})

/**
 * Stable boundary around the bounded page window and full numeric layout.
 * Hiding/reopening the reader retains both without rebuilding PDF resources.
 */
const PdfPages = memo(function PdfPages(props: {
  doc: PDFDocumentProxy
  currentPage: number
  layoutScale: number
  renderScale: number
  documentRotation: PdfPageRotation
  pageRotations: Readonly<Record<number, PdfPageRotation>>
  rotationRevision: number
  pageSizes: Readonly<Record<number, PageSize>>
  stackLayout: PageStackLayout
  selections: readonly SelectionInfo[]
  evidenceImages: readonly { selection: PdfEvidenceImage; order: number }[]
  annotations: readonly PdfTextMarkupAnnotation[]
  bookmarks: readonly PdfBookmark[]
  zoom: number
  evidenceText: PdfTextEvidence | undefined
  evidenceImage: PdfCitationImageTarget | undefined
  evidenceHighlightRevision: number
  imageLimits: ComposerImageLimits | undefined
  onSelect: (selection: SelectionInfo, anchor: ClientRectSnapshot) => void
  onSelectionRemove: (selection: SelectionInfo) => void
  onSelectionActivate: (selection: SelectionInfo, anchor: ClientRectSnapshot) => void
  onEvidenceImageRemove: (selection: SelectionInfo) => void
  onSelectionError: (message: string) => void
  interactionMode: PdfInteractionMode
  onTextUnavailable: (pageNumber: number) => void
  onAnnotationActivate: (annotation: PdfTextMarkupAnnotation, anchor: ClientRectSnapshot) => void
  onBookmarkAdd: (draft: { parentId: string | null; title: string; pageNumber?: number }) => void
  onBookmarkRemove: (id: string) => void
  searchHighlight: ActivePdfSearchHit | undefined
  onSize: (pageNumber: number, size: PageSize) => void
  pagePreviews: ReadonlyMap<number, HTMLCanvasElement>
  onPagePaint: (pageNumber: number, canvas: HTMLCanvasElement) => void
}) {
  const [hoveredPage, setHoveredPage] = useState<number | undefined>(undefined)
  const [focusedBookmarkPage, setFocusedBookmarkPage] = useState<number | undefined>(undefined)
  const bookmarksByPage = useMemo(
    () => {
      const byPage = new Map<number, PdfBookmark[]>()
      for (const bookmark of props.bookmarks) {
        if (bookmark.pageNumber === undefined) continue
        const pageBookmarks = byPage.get(bookmark.pageNumber) ?? []
        pageBookmarks.push(bookmark)
        byPage.set(bookmark.pageNumber, pageBookmarks)
      }
      return byPage
    },
    [props.bookmarks],
  )
  const handleRepaintSettled = useCallback((key: string, order: number): void => {
    const advance = (): void => {
      setRepaintSequence(current => current.key === key && current.turn === order
        ? { ...current, turn: order + 1 }
        : current)
    }
    // The current page owns turn 0. Every later turn is admitted only after
    // the preceding page completed and at least one paint boundary passed.
    // requestIdleCallback alone is insufficient: Chrome may chain several
    // newly queued idle callbacks inside the SAME idle period.
    window.requestAnimationFrame(() => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(advance, { timeout: 250 })
      } else {
        window.setTimeout(advance, 16)
      }
    })
  }, [])

  const firstActive = Math.max(1, props.currentPage - PAGE_WINDOW_RADIUS)
  const lastActive = Math.min(props.doc.numPages, props.currentPage + PAGE_WINDOW_RADIUS)
  const repaintPages: number[] = [props.currentPage]
  for (let distance = 1; distance <= PAGE_WINDOW_RADIUS; distance += 1) {
    if (props.currentPage - distance >= 1) repaintPages.push(props.currentPage - distance)
    if (props.currentPage + distance <= props.doc.numPages) repaintPages.push(props.currentPage + distance)
  }
  const repaintKey = `${String(props.currentPage)}:${String(props.renderScale)}:${String(props.rotationRevision)}`
  const [repaintSequence, setRepaintSequence] = useState(() => ({ key: repaintKey, turn: 0 }))

  useEffect(() => {
    setRepaintSequence(current => current.key === repaintKey ? current : { key: repaintKey, turn: 0 })
  }, [repaintKey])

  return Array.from({ length: lastActive - firstActive + 1 }, (_, index) => {
    const pageNumber = firstActive + index
    const knownSize = props.pageSizes[pageNumber]
    const geometry = props.stackLayout.pages[pageNumber - 1]
    if (geometry === undefined) return null
    const repaintOrder = repaintPages.indexOf(pageNumber)
    const rotation = effectivePdfPageRotation(props.documentRotation, props.pageRotations[pageNumber])
    return (
      <div
        key={pageNumber}
        data-page={pageNumber}
        data-pdf-current={pageNumber === props.currentPage ? 'true' : undefined}
        data-pdf-rotation={String(rotation)}
        data-pdf-preview-cached={props.pagePreviews.has(pageNumber) ? 'true' : undefined}
        onPointerEnter={() => { setHoveredPage(pageNumber) }}
        onPointerLeave={() => { setHoveredPage(current => current === pageNumber ? undefined : current) }}
        style={{
          ...styles.pageWrap,
          position: 'absolute',
          top: `${String(geometry.top)}px`,
          left: `${String(geometry.left)}px`,
          width: `${String(geometry.width)}px`,
          height: `${String(geometry.height)}px`,
          margin: 0,
        }}
      >
        <PdfPage
          doc={props.doc}
          pageNumber={pageNumber}
          rotation={rotation}
          layoutScale={props.layoutScale}
          renderScale={props.renderScale}
          knownSize={knownSize}
          committedSelections={[
            ...props.selections.map((selection, selectionIndex) => ({ selection, order: selectionIndex + 1, destination: 'composer' as const })),
            ...props.evidenceImages.map(({ selection, order }) => ({ selection, order, destination: 'evidence' as const })),
          ]
            .filter(committed => committed.selection.pageNumber === pageNumber)}
          annotations={props.annotations.filter(annotation => annotation.pageNumber === pageNumber)}
          evidenceRects={props.evidenceText?.drafts
            .filter(draft => draft.pageNumber === pageNumber)
            .flatMap(draft => draft.rects) ?? []}
          evidenceImage={props.evidenceImage?.pageNumber === pageNumber ? props.evidenceImage : undefined}
          evidenceHighlightRevision={props.evidenceHighlightRevision}
          imageLimits={props.imageLimits}
          onSize={props.onSize}
          onSelect={props.onSelect}
          onSelectionRemove={props.onSelectionRemove}
          onSelectionActivate={props.onSelectionActivate}
          onEvidenceImageRemove={props.onEvidenceImageRemove}
          onSelectionError={props.onSelectionError}
          interactionMode={props.interactionMode}
          onTextUnavailable={props.onTextUnavailable}
          onAnnotationActivate={props.onAnnotationActivate}
          searchHighlight={props.searchHighlight?.result.pageNumber === pageNumber ? props.searchHighlight : undefined}
          pagePreview={props.pagePreviews.get(pageNumber)}
          retainPreview={pageNumber === props.currentPage}
          onPagePaint={props.onPagePaint}
          repaintKey={repaintKey}
          repaintOrder={repaintOrder}
          repaintAllowed={repaintSequence.key === repaintKey && repaintSequence.turn === repaintOrder}
          onRepaintSettled={handleRepaintSettled}
        />
        {(() => {
          const pageBookmarks = bookmarksByPage.get(pageNumber) ?? []
          const existingBookmark = pageBookmarks[0]
          const alreadyBookmarked = existingBookmark !== undefined
          const bookmarkLimitReached = props.bookmarks.length >= MAX_PDF_BOOKMARKS
          const visible = hoveredPage === pageNumber || focusedBookmarkPage === pageNumber
          return (
            <button
              type="button"
              data-pdf-page-bookmark="true"
              data-pdf-page-bookmarked={alreadyBookmarked ? 'true' : 'false'}
              aria-label={alreadyBookmarked
                ? `取消第 ${String(pageNumber)} 页书签`
                : bookmarkLimitReached
                  ? 'PDF 书签已达到上限'
                  : `为第 ${String(pageNumber)} 页添加书签`}
              title={alreadyBookmarked
                ? `取消书签：${existingBookmark?.title ?? `第 ${String(pageNumber)} 页`}`
                : bookmarkLimitReached
                  ? 'PDF 书签已达到上限'
                  : '为本页添加书签'}
              disabled={!alreadyBookmarked && bookmarkLimitReached}
              style={{
                ...styles.pageBookmarkButton,
                ...(alreadyBookmarked ? styles.pageBookmarkButtonAdded : {}),
                opacity: visible ? 1 : 0,
                pointerEvents: visible ? 'auto' : 'none',
                transform: `scale(${String(1 / props.zoom)})`,
              }}
              onFocus={() => { setFocusedBookmarkPage(pageNumber) }}
              onBlur={() => { setFocusedBookmarkPage(current => current === pageNumber ? undefined : current) }}
              onPointerDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.stopPropagation()
                if (existingBookmark !== undefined) {
                  const descendantCount = pdfBookmarkDescendantIds(props.bookmarks, existingBookmark.id).size
                  if (descendantCount > 0 && !window.confirm(
                    `书签“${existingBookmark.title}”包含 ${String(descendantCount)} 个子书签，取消它会同时删除整个分支。是否继续？`,
                  )) return
                  props.onBookmarkRemove(existingBookmark.id)
                  return
                }
                if (bookmarkLimitReached) return
                props.onBookmarkAdd({
                  parentId: null,
                  title: `第 ${String(pageNumber)} 页`,
                  pageNumber,
                })
              }}
            >
              <BookmarkPdfIcon filled={alreadyBookmarked} />
            </button>
          )
        })()}
      </div>
    )
  })
})

/** Continuous-scroll PDF viewer with fit-width zoom and composer-backed selection. */
export function PdfViewer(props: PdfViewerProps) {
  const restoredState = props.initialSessionState
  const restoredZoom = Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, restoredState?.zoom ?? 1))
  const [doc, setDoc] = useState<PDFDocumentProxy | undefined>(undefined)
  const [failed, setFailed] = useState<string | undefined>(undefined)
  const [zoom, setZoom] = useState(restoredZoom)
  /** Debounced zoom that actually triggers page repaints; `zoom` only CSS-stretches. */
  const [renderZoom, setRenderZoom] = useState(restoredZoom)
  const [baseSize, setBaseSize] = useState<PageSize | undefined>(undefined)
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({})
  /** View-only rotation: one document baseline plus sparse page adjustments. */
  const [documentRotation, setDocumentRotation] = useState<PdfPageRotation>(restoredState?.documentRotation ?? 0)
  const [pageRotations, setPageRotations] = useState<Record<number, PdfPageRotation>>(() => ({ ...restoredState?.pageRotations }))
  const [rotationRevision, setRotationRevision] = useState(0)
  const rotationAnchorRef = useRef<PageLayoutAnchor | undefined>(undefined)
  /** Document-local LRU of downsampled revisit placeholders. */
  const pagePreviewCacheRef = useRef<Map<number, HTMLCanvasElement>>(new Map())
  /** Immutable projection makes cache writes explicit across the memoized page-list boundary. */
  const [pagePreviews, setPagePreviews] = useState<ReadonlyMap<number, HTMLCanvasElement>>(() => new Map())
  const scrollerRef = useRef<HTMLDivElement>(null)
  const documentTabsRef = useRef<HTMLDivElement>(null)
  const [fitMode, setFitMode] = useState<PdfFitMode>(restoredState?.fitMode ?? 'width')
  const [fitWidth, setFitWidth] = useState(0)
  const [fitHeight, setFitHeight] = useState(0)
  /** Portal panel: sidebar track motion follows imperatively without PDF relayout. */
  const widePanelRef = useRef<HTMLDivElement>(null)
  /** Last width admitted to React plus the content anchor for its next commit. */
  const fitWidthRef = useRef(0)
  const fitHeightRef = useRef(0)
  const fitWidthAnchorRef = useRef<PageLayoutAnchor | undefined>(undefined)
  const [currentPage, setCurrentPage] = useState(restoredState?.readingAnchor.pageNumber ?? 1)
  const [editingPage, setEditingPage] = useState(false)
  const pageInputRef = useRef<HTMLInputElement>(null)
  const navigationControlsRef = useRef<HTMLDivElement>(null)
  const zoomControlsRef = useRef<HTMLDivElement>(null)
  const [navigationControlsVisible, setNavigationControlsVisible] = useState(false)
  const [zoomControlsVisible, setZoomControlsVisible] = useState(false)
  const cornerControlHideTimersRef = useRef<{ navigation: number | null; zoom: number | null }>({
    navigation: null,
    zoom: null,
  })
  const navigationBackRef = useRef<readonly PdfNavigationLocation[]>([])
  const navigationForwardRef = useRef<readonly PdfNavigationLocation[]>([])
  const [navigationAvailability, setNavigationAvailability] = useState<PdfNavigationAvailability>({
    back: false,
    forward: false,
  })
  /** Mirror of the committed zoom state for the imperative gesture path. */
  const zoomRef = useRef(zoom)
  /** In-gesture absolute zoom applied to the stable page stack. */
  const gestureZoomRef = useRef(1)
  /** Whether the sizer and transform currently contain imperative gesture values. */
  const zoomGestureActiveRef = useRef(false)
  /** Settle timer: the gesture commits to React state 180ms after the last tick. */
  const settleTimerRef = useRef<number | null>(null)
  /** The one layout box that owns the scaled document's scroll overflow. */
  const zoomSizerRef = useRef<HTMLDivElement>(null)
  /** The stable-size page stack (the permanent compositor transform target). */
  const contentRef = useRef<HTMLDivElement>(null)
  /** Latest unzoomed stack geometry for the imperative gesture path. */
  const pageStackLayoutRef = useRef<PageStackLayout>({ width: 1, height: 1, layoutScale: 1, pages: [] })
  /** The % label span (imperatively updated mid-gesture). */
  const zoomSpanRef = useRef<HTMLButtonElement>(null)
  /** Last mouse point inside the PDF viewport; keyboard zoom anchors here. */
  const pointerZoomAnchorRef = useRef<Point | undefined>(undefined)
  const [interactionMode, setInteractionMode] = useState<PdfInteractionMode>('text')
  const textSelectionDraggingRef = useRef(false)
  const textSelectionAnchorRef = useRef<{ node: Node; offset: number } | undefined>(undefined)
  const textSelectionClampFrameRef = useRef<number | undefined>(undefined)
  const [annotationMenu, setAnnotationMenu] = useState<PdfAnnotationMenuState | undefined>(undefined)
  const [preferredHighlightColor, setPreferredHighlightColor] = useState<PdfMarkupColor>('yellow')
  const [preferredMarkupStrokeWidth, setPreferredMarkupStrokeWidth] = useState<PdfMarkupStrokeWidth>(2)
  const [annotationPaletteOpen, setAnnotationPaletteOpen] = useState(false)
  const [annotationStrokeMenuOpen, setAnnotationStrokeMenuOpen] = useState(false)
  const [annotationNoteGroupId, setAnnotationNoteGroupId] = useState<string | undefined>(undefined)
  const [annotationNoteDraft, setAnnotationNoteDraft] = useState('')
  const [annotationCopyStatus, setAnnotationCopyStatus] = useState<'copied' | 'failed' | undefined>(undefined)
  const [annotationAiMenuOpen, setAnnotationAiMenuOpen] = useState(false)
  const [annotationAiQuestionOpen, setAnnotationAiQuestionOpen] = useState(false)
  const [annotationAiQuestionDraft, setAnnotationAiQuestionDraft] = useState('')
  const [annotationAiBusy, setAnnotationAiBusy] = useState<PdfAiAction | undefined>(undefined)
  const [mixedTextIntent, setMixedTextIntent] = useState(false)
  const [mixedAiBusy, setMixedAiBusy] = useState<PdfMixedAiAction | undefined>(undefined)
  const textEvidence = props.textEvidence
  const selectedEvidenceImages = props.selectedEvidenceImages
  const selectedTextEvidenceIds = props.selectedTextEvidenceIds
  const selectedTextEvidence = textEvidence.filter(source => selectedTextEvidenceIds.has(source.id))
  const [readingAnchor, setReadingAnchor] = useState<PdfStoredReadingAnchor>(() => restoredState?.readingAnchor ?? {
    pageNumber: 1,
    pageXRatio: 0.5,
    pageYRatio: 0,
  })
  const initialReadingAnchorRef = useRef<PdfStoredReadingAnchor | undefined>(restoredState?.readingAnchor)
  const [activeEvidenceText, setActiveEvidenceText] = useState<PdfTextEvidence | undefined>(undefined)
  const [activeEvidenceImage, setActiveEvidenceImage] = useState<PdfCitationImageTarget | undefined>(undefined)
  const [evidenceHighlightRevision, setEvidenceHighlightRevision] = useState(0)
  const evidenceHighlightTimerRef = useRef<number | undefined>(undefined)
  const [imageAiMenu, setImageAiMenu] = useState<PdfImageAiMenuState | undefined>(undefined)
  const [imageAiQuestionOpen, setImageAiQuestionOpen] = useState(false)
  const [imageAiQuestionDraft, setImageAiQuestionDraft] = useState('')
  const [imageAiBusy, setImageAiBusy] = useState<PdfImageAiAction | undefined>(undefined)
  const annotationMenuRef = useRef<HTMLDivElement>(null)
  const annotationNoteInputRef = useRef<HTMLTextAreaElement>(null)
  const annotationAiQuestionInputRef = useRef<HTMLTextAreaElement>(null)
  const imageAiMenuRef = useRef<HTMLDivElement>(null)
  const imageAiQuestionInputRef = useRef<HTMLTextAreaElement>(null)
  const annotationCopyTimerRef = useRef<number | undefined>(undefined)
  const [annotationMenuPlacement, setAnnotationMenuPlacement] = useState({ left: 8, top: 8 })
  const [imageAiMenuPlacement, setImageAiMenuPlacement] = useState({ left: 8, top: 8 })
  const annotationMenuIdentity = annotationMenu?.kind === 'annotation'
    ? `annotation:${annotationMenu.groupId}`
    : annotationMenu === undefined
      ? 'none'
      : `selection:${String(annotationMenu.pending.text.length)}:${String(annotationMenu.pending.anchor.left)}:${String(annotationMenu.pending.anchor.top)}:${String(annotationMenu.pending.anchor.right)}:${String(annotationMenu.pending.anchor.bottom)}`
  const [interactionNotice, setInteractionNotice] = useState<string | undefined>(undefined)
  const interactionNoticeTimerRef = useRef<number | undefined>(undefined)
  const [selectionError, setSelectionError] = useState<string | undefined>(undefined)
  const [evidenceDrawerOpen, setEvidenceDrawerOpen] = useState(false)
  const [rotationMenuOpen, setRotationMenuOpen] = useState(false)
  const rotationMenuRef = useRef<HTMLDivElement>(null)
  const [saveMenuOpen, setSaveMenuOpen] = useState(false)
  const saveMenuRef = useRef<HTMLDivElement>(null)
  const [fitMenuOpen, setFitMenuOpen] = useState(false)
  const fitMenuRef = useRef<HTMLDivElement>(null)
  const [thumbnailsOpen, setThumbnailsOpen] = useState(false)
  const [annotationDrawerOpen, setAnnotationDrawerOpen] = useState(false)
  const [outlineItems, setOutlineItems] = useState<readonly ResolvedPdfOutlineItem[]>([])
  const [outlineReady, setOutlineReady] = useState(false)
  /** Resolved once per document, bounded by MAX_OUTLINE_ITEMS upstream. */
  const [outlinePages, setOutlinePages] = useState<ReadonlyMap<string, number>>(() => new Map())
  /** Per-document view state; PdfViewer's loaded.id key resets it on replacement. */
  const [expandedOutlineIds, setExpandedOutlineIds] = useState<ReadonlySet<string>>(() => new Set())
  const [navigationDrawer, setNavigationDrawer] = useState<PdfSidebarMode | undefined>(undefined)
  const previousNavigationDrawerRef = useRef<PdfSidebarMode | undefined>(undefined)
  const [pdfSearch, setPdfSearch] = useState<PdfSearchState>(() => emptyPdfSearchState())
  const [activeSearchHit, setActiveSearchHit] = useState<ActivePdfSearchHit | undefined>(undefined)
  /** Incrementing invalidates the previous scan without retaining its promise. */
  const searchGenerationRef = useRef(0)
  const searchSessionRef = useRef<PdfSearchSession | undefined>(undefined)
  const searchLoadingRef = useRef(false)
  /** Per-document text cache; scans remain complete after this bound is full. */
  const searchTextCacheRef = useRef<Map<number, string>>(new Map())
  const searchTextCacheUnitsRef = useRef(0)
  const documentIndexReadyRef = useRef<Promise<void>>(Promise.resolve())
  const documentIndexInstanceRef = useRef(createPdfDocumentId())
  const documentQuestionInputRef = useRef<HTMLTextAreaElement>(null)
  const [documentQuestionOpen, setDocumentQuestionOpen] = useState(false)
  const [documentQuestionDraft, setDocumentQuestionDraft] = useState('')
  const [documentQuestionBusy, setDocumentQuestionBusy] = useState(false)
  const [documentQuestionSelectedIds, setDocumentQuestionSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set([props.documentId]),
  )
  const [documentQuestionOcrAllowed, setDocumentQuestionOcrAllowed] = useState(false)
  const [documentQuestionOcrPreferences, setDocumentQuestionOcrPreferences] = useState(() => {
    try {
      return loadPdfOcrPreferences(window.localStorage)
    } catch {
      return { ...DEFAULT_PDF_OCR_PREFERENCES }
    }
  })
  const [documentIndexStatus, setDocumentIndexStatus] = useState<
    | { kind: 'indexing'; indexedPages: number; totalPages: number }
    | { kind: 'ready'; indexedPages: number; totalPages: number; truncated: boolean }
    | { kind: 'error'; message: string }
  >({ kind: 'indexing', indexedPages: 0, totalPages: 0 })
  const { wide } = props
  /** Wide-mode panel width in px (0 = not yet chosen; defaults to 55% of the viewport). */
  const [widePx, setWidePx] = useState(() => Math.max(0, props.initialWideWidth))
  /** Rendered width of the app's sidebar column (the rail the panel docks after). */
  const [sidebarW, setSidebarW] = useState(() => wide ? currentHarnessSidebarWidth() : 0)
  /** Last sidebar position committed into React geometry. */
  const sidebarWRef = useRef(sidebarW)
  const [viewportW, setViewportW] = useState(() => window.innerWidth)
  const resizePointerRef = useRef<number | null>(null)
  // The automatic reader width is chosen against the sidebar state present
  // when this reader first settles. Opening a workspace/outline sidebar may
  // move the reader, but must not resize all PDF pages and relayout a long
  // document. The current sidebar still participates in the conversation
  // minimum clamp below, so an actually tight viewport remains safe.
  const initialSidebarWRef = useRef(sidebarW)
  if (initialSidebarWRef.current === 0 && sidebarW > 0) initialSidebarWRef.current = sidebarW
  const automaticPanelW = initialSidebarWRef.current > 0
    ? Math.round((viewportW - initialSidebarWRef.current) * 0.55)
    : 0
  const geometry = computeWideGeometry(viewportW, sidebarW, widePx > 0 ? widePx : automaticPanelW)
  const panelW = geometry.panelWidth
  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const tabs = documentTabsRef.current
      if (tabs === null) return
      const activeTab = Array.from(tabs.querySelectorAll<HTMLElement>('[data-pdf-document-tab]'))
        .find(tab => tab.dataset.pdfDocumentTab === props.activeDocumentId)
      if (activeTab === undefined) return
      const stripRect = tabs.getBoundingClientRect()
      const activeRect = activeTab.getBoundingClientRect()
      if (activeRect.left < stripRect.left) {
        tabs.scrollLeft = Math.max(0, tabs.scrollLeft - (stripRect.left - activeRect.left) - 6)
      } else if (activeRect.right > stripRect.right) {
        tabs.scrollLeft += activeRect.right - stripRect.right + 6
      }
    })
    return () => { window.cancelAnimationFrame(frame) }
  }, [doc, panelW, props.activeDocumentId, props.documents.length, props.wide])
  const defaultPageSize = baseSize ?? FALLBACK_PAGE_SIZE
  const fitScale = baseSize === undefined
    ? 1
    : fitMode === 'page'
      ? pdfPageFitPageScale(
        fitWidth,
        Math.max(1, fitHeight - PDF_STACK_BOTTOM_PADDING),
        defaultPageSize,
        pageSizes,
        documentRotation,
        pageRotations,
      )
      : pdfPageFitScale(fitWidth, defaultPageSize, pageSizes, documentRotation, pageRotations)
  const pageStackLayout = useMemo(
    () => pdfPageStackLayout(
      doc?.numPages ?? 0,
      defaultPageSize,
      pageSizes,
      fitScale,
      documentRotation,
      pageRotations,
    ),
    [defaultPageSize, doc?.numPages, documentRotation, fitScale, pageRotations, pageSizes],
  )
  pageStackLayoutRef.current = pageStackLayout
  const rotationForPage = useCallback((pageNumber: number): PdfPageRotation => (
    effectivePdfPageRotation(documentRotation, pageRotations[pageNumber])
  ), [documentRotation, pageRotations])
  const handlePageSize = useCallback((pageNumber: number, size: PageSize): void => {
    setPageSizes(current => {
      const previous = current[pageNumber]
      if (previous?.width === size.width && previous.height === size.height) return current
      return { ...current, [pageNumber]: size }
    })
  }, [])
  const retainPagePreview = useCallback((pageNumber: number, source: HTMLCanvasElement): void => {
    const target = fitWithinPixels(source.width, source.height, PAGE_PREVIEW_MAX_PIXELS)
    const cache = pagePreviewCacheRef.current
    const preview = cache.get(pageNumber) ?? document.createElement('canvas')
    // Delete before re-inserting so Map iteration remains true LRU order.
    cache.delete(pageNumber)
    preview.width = target.width
    preview.height = target.height
    const context = preview.getContext('2d')
    if (context === null) {
      preview.width = 1
      preview.height = 1
      return
    }
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(source, 0, 0, target.width, target.height)
    cache.set(pageNumber, preview)

    let cachedPixels = 0
    for (const cached of cache.values()) cachedPixels += cached.width * cached.height
    while (cache.size > PAGE_PREVIEW_CACHE_MAX_ENTRIES || cachedPixels > PAGE_PREVIEW_CACHE_MAX_PIXELS) {
      const oldest = cache.entries().next().value as [number, HTMLCanvasElement] | undefined
      if (oldest === undefined) break
      cache.delete(oldest[0])
      cachedPixels -= oldest[1].width * oldest[1].height
      // Resizing releases the browser-side backing store before eviction.
      oldest[1].width = 1
      oldest[1].height = 1
    }
    setPagePreviews(new Map(cache))
  }, [])
  const clearPagePreviews = useCallback((): void => {
    for (const preview of pagePreviewCacheRef.current.values()) {
      preview.width = 1
      preview.height = 1
    }
    pagePreviewCacheRef.current.clear()
    setPagePreviews(new Map())
  }, [])
  const applyZoomGeometry = useCallback((nextZoom: number): void => {
    const sizer = zoomSizerRef.current
    const content = contentRef.current
    if (sizer === null || content === null) return
    const stack = pageStackLayoutRef.current
    sizer.style.width = `${String(stack.width * nextZoom)}px`
    sizer.style.height = `${String(stack.height * nextZoom)}px`
    content.style.transform = `scale(${String(nextZoom)})`
  }, [])

  // Repaint debounce: rapid zoom ticks (pinch streams, wheel flurries) only
  // stretch the existing bitmaps via CSS; the expensive pdf.js repaint runs
  // once, after the gesture settles.
  useEffect(() => {
    if (renderZoom === zoom) return
    const timer = setTimeout(() => { setRenderZoom(zoom) }, 220)
    return () => { clearTimeout(timer) }
  }, [zoom, renderZoom])

  /** Every window open/close request funnels to the owning panel. */
  const toggleWide = (open: boolean): void => {
    props.onWideChange(open)
  }

  const captureRotationAnchor = useCallback((rotation: PdfPageRotation, affectedPage?: number): void => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    const anchor = capturePageLayoutAnchor(scroller)
    if (anchor === undefined) return
    if (affectedPage === undefined || anchor.pageNumber === affectedPage) {
      const point = rotateNormalizedPdfPoint(
        { x: anchor.pageXRatio, y: anchor.pageYRatio },
        rotation,
      )
      anchor.pageXRatio = point.x
      anchor.pageYRatio = point.y
    }
    rotationAnchorRef.current = anchor
  }, [])

  /** Rotate current/all pages in memory; source PDF bytes are never mutated. */
  const rotateView = useCallback((scope: 'current' | 'all', delta: -90 | 90): void => {
    const normalizedDelta = normalizePdfRotation(delta)
    captureRotationAnchor(normalizedDelta, scope === 'current' ? currentPage : undefined)
    clearPagePreviews()
    setSelectionError(undefined)
    setRotationMenuOpen(false)
    if (scope === 'all') {
      setDocumentRotation(current => normalizePdfRotation(current + delta))
    } else {
      setPageRotations(current => {
        const nextRotation = normalizePdfRotation((current[currentPage] ?? 0) + delta)
        if (nextRotation === 0) {
          const next = { ...current }
          delete next[currentPage]
          return next
        }
        return { ...current, [currentPage]: nextRotation }
      })
    }
    setRotationRevision(current => current + 1)
  }, [captureRotationAnchor, clearPagePreviews, currentPage])

  const resetCurrentRotation = useCallback((): void => {
    const currentRotation = rotationForPage(currentPage)
    if (currentRotation === 0) {
      setRotationMenuOpen(false)
      return
    }
    captureRotationAnchor(normalizePdfRotation(-currentRotation), currentPage)
    clearPagePreviews()
    setPageRotations(current => {
      const nextRotation = normalizePdfRotation(-documentRotation)
      if (nextRotation === 0) {
        const next = { ...current }
        delete next[currentPage]
        return next
      }
      return { ...current, [currentPage]: nextRotation }
    })
    setRotationMenuOpen(false)
    setRotationRevision(current => current + 1)
  }, [captureRotationAnchor, clearPagePreviews, currentPage, documentRotation, rotationForPage])

  const resetAllRotations = useCallback((): void => {
    const scroller = scrollerRef.current
    const anchor = scroller === null ? undefined : capturePageLayoutAnchor(scroller)
    if (anchor !== undefined) {
      const point = rotateNormalizedPdfPoint(
        { x: anchor.pageXRatio, y: anchor.pageYRatio },
        normalizePdfRotation(-rotationForPage(anchor.pageNumber)),
      )
      rotationAnchorRef.current = { ...anchor, pageXRatio: point.x, pageYRatio: point.y }
    }
    clearPagePreviews()
    setDocumentRotation(0)
    setPageRotations({})
    setRotationMenuOpen(false)
    setRotationRevision(current => current + 1)
  }, [clearPagePreviews, rotationForPage])

  useEffect(() => {
    const onResize = (): void => { setViewportW(window.innerWidth) }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])

  /** Pointer capture keeps the resize gesture inside this component lifecycle. */
  const startWideResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (geometry.overlay || event.button !== 0) return
    event.preventDefault()
    resizePointerRef.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveWideResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (resizePointerRef.current !== event.pointerId || geometry.overlay) return
    const nextWidth = event.clientX - sidebarW
    setWidePx(nextWidth)
    props.onWideWidthChange(nextWidth)
  }
  const finishWideResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (resizePointerRef.current === event.pointerId) resizePointerRef.current = null
  }

  type CornerControl = 'navigation' | 'zoom'
  const cancelCornerControlHide = (control: CornerControl): void => {
    const timer = cornerControlHideTimersRef.current[control]
    if (timer !== null) window.clearTimeout(timer)
    cornerControlHideTimersRef.current[control] = null
  }
  const revealCornerControl = (control: CornerControl): void => {
    cancelCornerControlHide(control)
    if (control === 'navigation') setNavigationControlsVisible(true)
    else setZoomControlsVisible(true)
  }
  const scheduleCornerControlHide = (control: CornerControl): void => {
    if (cornerControlHideTimersRef.current[control] !== null) return
    cornerControlHideTimersRef.current[control] = window.setTimeout(() => {
      cornerControlHideTimersRef.current[control] = null
      const element = control === 'navigation' ? navigationControlsRef.current : zoomControlsRef.current
      if (element?.contains(document.activeElement)) return
      if (control === 'navigation') setNavigationControlsVisible(false)
      else setZoomControlsVisible(false)
    }, CORNER_CONTROL_HIDE_DELAY_MS)
  }
  const handleCornerControlPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== 'mouse') return
    pointerZoomAnchorRef.current = { x: event.clientX, y: event.clientY }
    // Hover controls must not appear underneath an in-progress crop drag.
    if (event.buttons !== 0) return
    const near = (element: HTMLElement | null): boolean => {
      if (element === null) return false
      const rect = element.getBoundingClientRect()
      return event.clientX >= rect.left - CORNER_CONTROL_PROXIMITY_PX
        && event.clientX <= rect.right + CORNER_CONTROL_PROXIMITY_PX
        && event.clientY >= rect.top - CORNER_CONTROL_PROXIMITY_PX
        && event.clientY <= rect.bottom + CORNER_CONTROL_PROXIMITY_PX
    }
    if (near(navigationControlsRef.current)) revealCornerControl('navigation')
    else scheduleCornerControlHide('navigation')
    if (near(zoomControlsRef.current)) revealCornerControl('zoom')
    else scheduleCornerControlHide('zoom')
  }

  useEffect(() => {
    if (!wide) {
      cancelCornerControlHide('navigation')
      cancelCornerControlHide('zoom')
      setNavigationControlsVisible(false)
      setZoomControlsVisible(false)
    }
    return () => {
      cancelCornerControlHide('navigation')
      cancelCornerControlHide('zoom')
    }
  }, [wide])

  // Escape closes transient navigation first, exits crop mode next, then
  // closes the reader. A screenshot tool must never trap the next left drag.
  useEffect(() => {
    if (!wide) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (documentQuestionOpen) {
        if (!documentQuestionBusy) setDocumentQuestionOpen(false)
        return
      }
      if (navigationDrawer !== undefined) setNavigationDrawer(undefined)
      else if (evidenceDrawerOpen) setEvidenceDrawerOpen(false)
      else if (annotationDrawerOpen) setAnnotationDrawerOpen(false)
      else if (thumbnailsOpen) setThumbnailsOpen(false)
      else if (fitMenuOpen) setFitMenuOpen(false)
      else if (rotationMenuOpen) setRotationMenuOpen(false)
      else if (saveMenuOpen) setSaveMenuOpen(false)
      else if (imageAiQuestionOpen) setImageAiQuestionOpen(false)
      else if (imageAiMenu !== undefined) setImageAiMenu(undefined)
      else if (annotationAiQuestionOpen) {
        setAnnotationAiQuestionOpen(false)
        setAnnotationAiMenuOpen(true)
      }
      else if (annotationAiMenuOpen) setAnnotationAiMenuOpen(false)
      else if (annotationNoteGroupId !== undefined) setAnnotationNoteGroupId(undefined)
      else if (annotationStrokeMenuOpen) setAnnotationStrokeMenuOpen(false)
      else if (annotationPaletteOpen) setAnnotationPaletteOpen(false)
      else if (annotationMenu !== undefined) {
        window.getSelection()?.removeAllRanges()
        setAnnotationMenu(undefined)
      }
      else if (interactionMode === 'crop') setInteractionMode('text')
      else toggleWide(false)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [annotationAiMenuOpen, annotationAiQuestionOpen, annotationDrawerOpen, annotationMenu, annotationNoteGroupId, annotationPaletteOpen, annotationStrokeMenuOpen, documentQuestionBusy, documentQuestionOpen, evidenceDrawerOpen, fitMenuOpen, imageAiMenu, imageAiQuestionOpen, interactionMode, wide, navigationDrawer, rotationMenuOpen, saveMenuOpen, thumbnailsOpen])

  // Transient reader surfaces close when hidden; collected evidence remains.
  useEffect(() => {
    if (!wide) setEvidenceDrawerOpen(false)
    if (!wide || (imageAiMenu !== undefined && !props.selections.includes(imageAiMenu.selection))) {
      setImageAiMenu(undefined)
      setImageAiQuestionOpen(false)
    }
    if (!wide) {
      if (!documentQuestionBusy) setDocumentQuestionOpen(false)
      setRotationMenuOpen(false)
      setSaveMenuOpen(false)
      setFitMenuOpen(false)
      setThumbnailsOpen(false)
      setAnnotationDrawerOpen(false)
      setInteractionMode('text')
      setAnnotationMenu(undefined)
      setInteractionNotice(undefined)
    }
  }, [documentQuestionBusy, imageAiMenu, props.selections, wide])

  const readPendingTextSelection = useCallback((): void => {
    if (textSelectionDraggingRef.current) return
    const selection = window.getSelection()
    const panel = widePanelRef.current
    if (!wide || interactionMode !== 'text' || selection === null || selection.isCollapsed || panel === null) {
      setAnnotationMenu(current => current?.kind === 'annotation' || annotationAiMenuOpen || annotationAiQuestionOpen ? current : undefined)
      return
    }
    const text = selection.toString().trim()
    if (text.length === 0) {
      setAnnotationMenu(current => current?.kind === 'annotation' || annotationAiMenuOpen || annotationAiQuestionOpen ? current : undefined)
      return
    }

    const drafts: PdfTextMarkupDraft[] = []
    const clientFragments: ClientRectSnapshot[] = []
    for (const pageElement of panel.querySelectorAll<HTMLElement>('div[data-page]')) {
      const pageNumber = Number(pageElement.dataset['page'])
      const rotation = normalizePdfRotation(Number(pageElement.dataset['pdfRotation'] ?? 0))
      const layer = pageElement.querySelector<HTMLElement>('[data-pdf-text-layer="true"]')
      if (!Number.isInteger(pageNumber) || layer === null) continue
      const layerBox = layer.getBoundingClientRect()
      if (layerBox.width <= 0 || layerBox.height <= 0 || layer.clientWidth <= 0 || layer.clientHeight <= 0) continue
      const scaleX = layer.clientWidth / layerBox.width
      const scaleY = layer.clientHeight / layerBox.height
      const localFragments: Rect[] = []
      for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
        const range = selection.getRangeAt(rangeIndex)
        try {
          if (!range.intersectsNode(layer)) continue
        } catch {
          continue
        }
        for (const fragment of range.getClientRects()) {
          const left = Math.max(fragment.left, layerBox.left)
          const top = Math.max(fragment.top, layerBox.top)
          const right = Math.min(fragment.right, layerBox.right)
          const bottom = Math.min(fragment.bottom, layerBox.bottom)
          if (right <= left || bottom <= top) continue
          clientFragments.push({ left, top, right, bottom, width: right - left, height: bottom - top })
          localFragments.push({
            x: (left - layerBox.left) * scaleX,
            y: (top - layerBox.top) * scaleY,
            width: (right - left) * scaleX,
            height: (bottom - top) * scaleY,
          })
        }
      }
      const rects = mergePdfTextSelectionRects(localFragments).map(rect => rotateNormalizedPdfRect({
        x: rect.x / layer.clientWidth,
        y: rect.y / layer.clientHeight,
        width: rect.width / layer.clientWidth,
        height: rect.height / layer.clientHeight,
      }, normalizePdfRotation(-rotation)))
      if (rects.length > 0) drafts.push({ pageNumber, rects, text })
    }
    const anchor = clientFragments.at(-1)
    if (drafts.length === 0 || anchor === undefined) {
      setAnnotationMenu(current => current?.kind === 'annotation' || annotationAiMenuOpen || annotationAiQuestionOpen ? current : undefined)
      return
    }
    setAnnotationMenu({ kind: 'selection', pending: { text, drafts, anchor } })
  }, [annotationAiMenuOpen, annotationAiQuestionOpen, interactionMode, wide])

  useEffect(() => {
    let settleFrame: number | undefined
    let finalFrame: number | undefined
    const cancelClamp = (): void => {
      if (textSelectionClampFrameRef.current === undefined) return
      window.cancelAnimationFrame(textSelectionClampFrameRef.current)
      textSelectionClampFrameRef.current = undefined
    }
    const eventLayer = (event: PointerEvent): HTMLElement | undefined => {
      if (!(event.target instanceof Element)) return undefined
      const layer = event.target.closest<HTMLElement>('[data-pdf-text-layer="true"]')
      return layer !== null && widePanelRef.current?.contains(layer) === true ? layer : undefined
    }
    const scheduleClamp = (event: PointerEvent, establishAnchor = false): void => {
      const layer = eventLayer(event)
      if (layer === undefined) return
      const visualCaret = pdfVisualCaretAtPoint(layer, event.clientX, event.clientY)
      if (establishAnchor) textSelectionAnchorRef.current = visualCaret
      const forcedAnchor = textSelectionAnchorRef.current
      if (visualCaret === undefined && forcedAnchor === undefined) return
      const focus = visualCaret ?? textCaretAtPoint(layer, event.clientX, event.clientY)
      if (focus === undefined) return
      cancelClamp()
      textSelectionClampFrameRef.current = window.requestAnimationFrame(() => {
        textSelectionClampFrameRef.current = undefined
        const selection = window.getSelection()
        if (selection === null) return
        try {
          if (establishAnchor && visualCaret !== undefined) {
            selection.collapse(visualCaret.node, visualCaret.offset)
          } else if (forcedAnchor !== undefined && forcedAnchor.node.isConnected) {
            selection.setBaseAndExtent(forcedAnchor.node, forcedAnchor.offset, focus.node, focus.offset)
          } else if (visualCaret !== undefined) {
            selection.extend(visualCaret.node, visualCaret.offset)
          }
        } catch {
          // A page may leave the bounded render window during a cross-page
          // drag. Native browser selection remains the safe fallback.
        }
      })
    }
    const begin = (event: PointerEvent): void => {
      if (event.button !== 0 || interactionMode !== 'text' || !wide || !(event.target instanceof Element)) return
      const layer = eventLayer(event)
      if (layer === undefined) return
      pdfTextCaretGeometryCache.delete(layer)
      textSelectionDraggingRef.current = true
      scheduleClamp(event, true)
      setAnnotationMenu(current => current?.kind === 'selection' ? undefined : current)
    }
    const move = (event: PointerEvent): void => {
      if (!textSelectionDraggingRef.current || event.pointerType === 'touch' || (event.buttons & 1) === 0) return
      scheduleClamp(event)
    }
    const finish = (event: PointerEvent): void => {
      if (!textSelectionDraggingRef.current) return
      if (event.type === 'pointerup' && event.pointerType !== 'touch') scheduleClamp(event)
      textSelectionDraggingRef.current = false
      textSelectionAnchorRef.current = undefined
      // Visual caret correction lands in the first animation frame.
      // Read the final native range one frame later so the menu never opens
      // underneath the pointer while the drag is still active.
      settleFrame = window.requestAnimationFrame(() => {
        settleFrame = undefined
        finalFrame = window.requestAnimationFrame(() => {
          finalFrame = undefined
          readPendingTextSelection()
        })
      })
    }
    document.addEventListener('pointerdown', begin, true)
    document.addEventListener('pointermove', move, true)
    document.addEventListener('pointerup', finish, true)
    document.addEventListener('pointercancel', finish, true)
    return () => {
      document.removeEventListener('pointerdown', begin, true)
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerup', finish, true)
      document.removeEventListener('pointercancel', finish, true)
      cancelClamp()
      if (settleFrame !== undefined) window.cancelAnimationFrame(settleFrame)
      if (finalFrame !== undefined) window.cancelAnimationFrame(finalFrame)
      textSelectionDraggingRef.current = false
      textSelectionAnchorRef.current = undefined
    }
  }, [interactionMode, readPendingTextSelection, wide])

  useEffect(() => {
    let frame: number | undefined
    const schedule = (): void => {
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = undefined
        readPendingTextSelection()
      })
    }
    document.addEventListener('selectionchange', schedule)
    schedule()
    return () => {
      document.removeEventListener('selectionchange', schedule)
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
  }, [readPendingTextSelection])

  const annotationMenuAnchor = annotationMenu?.kind === 'selection'
    ? annotationMenu.pending.anchor
    : annotationMenu?.anchor

  useLayoutEffect(() => {
    if (annotationMenuAnchor === undefined) return
    const menu = annotationMenuRef.current
    const width = menu?.offsetWidth ?? 210
    const height = menu?.offsetHeight ?? 40
    setAnnotationMenuPlacement(annotationMenuPosition(annotationMenuAnchor, width, height))
  }, [annotationMenuAnchor])

  useEffect(() => {
    if (annotationMenu === undefined) return
    const closeOutside = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || annotationMenuRef.current?.contains(event.target)) return
      if (event.target instanceof Element && event.target.closest('[data-pdf-text-markup-annotation="true"]') !== null) return
      setAnnotationMenu(undefined)
    }
    const closeOnViewportChange = (): void => { setAnnotationMenu(undefined) }
    const scroller = scrollerRef.current
    document.addEventListener('pointerdown', closeOutside)
    scroller?.addEventListener('scroll', closeOnViewportChange, { passive: true })
    window.addEventListener('resize', closeOnViewportChange)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      scroller?.removeEventListener('scroll', closeOnViewportChange)
      window.removeEventListener('resize', closeOnViewportChange)
    }
  }, [annotationMenuIdentity])

  useEffect(() => {
    if (annotationMenu?.kind === 'annotation'
      && !props.annotations.some(annotation => annotation.groupId === annotationMenu.groupId)) {
      setAnnotationMenu(undefined)
    }
  }, [annotationMenu, props.annotations])

  const activateAnnotation = useCallback((annotation: PdfTextMarkupAnnotation, anchor: ClientRectSnapshot): void => {
    window.getSelection()?.removeAllRanges()
    setAnnotationNoteGroupId(undefined)
    setAnnotationPaletteOpen(false)
    setAnnotationStrokeMenuOpen(false)
    setAnnotationMenu({ kind: 'annotation', groupId: annotation.groupId, anchor })
  }, [])

  useEffect(() => () => {
    if (interactionNoticeTimerRef.current !== undefined) {
      window.clearTimeout(interactionNoticeTimerRef.current)
    }
    if (evidenceHighlightTimerRef.current !== undefined) {
      window.clearTimeout(evidenceHighlightTimerRef.current)
    }
    if (annotationCopyTimerRef.current !== undefined) {
      window.clearTimeout(annotationCopyTimerRef.current)
    }
  }, [])
  useEffect(() => { setAnnotationPaletteOpen(false) }, [annotationMenu])
  useEffect(() => { setAnnotationStrokeMenuOpen(false) }, [annotationMenu])
  useEffect(() => {
    setAnnotationAiMenuOpen(false)
    setAnnotationAiQuestionOpen(false)
    setAnnotationAiQuestionDraft('')
  }, [annotationMenuIdentity])
  useEffect(() => {
    props.onSessionStateChange({
      zoom,
      fitMode,
      documentRotation,
      pageRotations,
      readingAnchor,
      textEvidence: [],
      selectedEvidenceImageIndexes: [],
      selectedTextEvidenceIds: [],
    })
  }, [
    documentRotation,
    fitMode,
    pageRotations,
    props.onSessionStateChange,
    readingAnchor,
    zoom,
  ])
  useEffect(() => {
    if (props.evidenceImages.length === 0) {
      setMixedTextIntent(false)
      if (mixedAiBusy === undefined) setAnnotationAiQuestionOpen(false)
    }
    if (props.evidenceImages.length === 0 && textEvidence.length === 0) setEvidenceDrawerOpen(false)
  }, [mixedAiBusy, props.evidenceImages.length, textEvidence.length])
  useEffect(() => {
    if (annotationCopyTimerRef.current !== undefined) {
      window.clearTimeout(annotationCopyTimerRef.current)
      annotationCopyTimerRef.current = undefined
    }
    setAnnotationCopyStatus(undefined)
  }, [annotationMenu])
  useEffect(() => {
    if (annotationNoteGroupId === undefined) return
    if (annotationMenu?.kind !== 'annotation' || annotationMenu.groupId !== annotationNoteGroupId) {
      setAnnotationNoteGroupId(undefined)
    }
  }, [annotationMenu, annotationNoteGroupId])
  useLayoutEffect(() => {
    if (annotationNoteGroupId !== undefined) annotationNoteInputRef.current?.focus()
  }, [annotationNoteGroupId])
  useLayoutEffect(() => {
    if (annotationAiQuestionOpen) annotationAiQuestionInputRef.current?.focus()
  }, [annotationAiQuestionOpen])

  useLayoutEffect(() => {
    if (imageAiMenu === undefined) return
    const menu = imageAiMenuRef.current
    setImageAiMenuPlacement(annotationMenuPosition(
      imageAiMenu.anchor,
      menu?.offsetWidth ?? 238,
      menu?.offsetHeight ?? (imageAiQuestionOpen ? 190 : 250),
    ))
  }, [imageAiMenu, imageAiQuestionOpen])

  useEffect(() => {
    if (imageAiMenu === undefined) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && imageAiMenuRef.current?.contains(event.target)) return
      setImageAiMenu(undefined)
      setImageAiQuestionOpen(false)
    }
    const closeOnViewportChange = (): void => {
      setImageAiMenu(undefined)
      setImageAiQuestionOpen(false)
    }
    const scroller = scrollerRef.current
    document.addEventListener('pointerdown', closeOutside)
    scroller?.addEventListener('scroll', closeOnViewportChange, { passive: true })
    window.addEventListener('resize', closeOnViewportChange)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      scroller?.removeEventListener('scroll', closeOnViewportChange)
      window.removeEventListener('resize', closeOnViewportChange)
    }
  }, [imageAiMenu])

  useLayoutEffect(() => {
    if (imageAiQuestionOpen) imageAiQuestionInputRef.current?.focus()
  }, [imageAiQuestionOpen])
  useLayoutEffect(() => {
    if (documentQuestionOpen) documentQuestionInputRef.current?.focus()
  }, [documentQuestionOpen])
  useEffect(() => {
    if (!rotationMenuOpen) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rotationMenuRef.current?.contains(event.target)) {
        setRotationMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [rotationMenuOpen])
  useEffect(() => {
    if (!saveMenuOpen) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !saveMenuRef.current?.contains(event.target)) {
        setSaveMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [saveMenuOpen])
  useEffect(() => {
    if (!fitMenuOpen) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !fitMenuRef.current?.contains(event.target)) {
        setFitMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [fitMenuOpen])

  // Measure the sidebar column (rail) width live: the panel docks after it.
  // The frame is the only element with an inline grid-template-columns, and
  // its first child is the sidebar column.
  useLayoutEffect(() => {
    if (!wide) return
    const frame = document.querySelector<HTMLElement>('div[style*="grid-template-columns"]')
    const sidebar = frame?.firstElementChild
    if (!(sidebar instanceof HTMLElement)) return
    // Harness animates its sidebar track. Feeding every intermediate width
    // into PDF fit-scale makes a long page stack relayout on every frame. Only
    // commit the final width after the ResizeObserver stream settles.
    let latestWidth = sidebar.getBoundingClientRect().width
    let settleTimer: number | undefined
    const measure = (): void => {
      latestWidth = sidebar.getBoundingClientRect().width
      // Moving only the fixed panel keeps it attached to the animated sidebar
      // edge without changing PDF layout. A transform stays on the compositor;
      // React receives only the settled width below, so PDF geometry never
      // participates in each sidebar animation frame.
      if (pushed.current !== null && widePanelRef.current !== null) {
        const delta = latestWidth - sidebarWRef.current
        widePanelRef.current.style.willChange = 'transform'
        widePanelRef.current.style.transform = Math.abs(delta) < 0.5
          ? ''
          : `translate3d(${String(delta)}px, 0, 0)`
      }
      if (settleTimer !== undefined) clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => {
        if (Math.abs(latestWidth - sidebarWRef.current) < 0.5) {
          if (widePanelRef.current !== null) {
            widePanelRef.current.style.transform = ''
            widePanelRef.current.style.willChange = ''
          }
        } else {
          setSidebarW(latestWidth)
        }
      }, 80)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(sidebar)
    return () => {
      observer.disconnect()
      if (settleTimer !== undefined) clearTimeout(settleTimer)
    }
  }, [wide])

  // Commit the final `left` and remove the temporary compositor offset in
  // the same pre-paint phase, so the handoff is visually continuous.
  useLayoutEffect(() => {
    sidebarWRef.current = sidebarW
    if (widePanelRef.current !== null) {
      widePanelRef.current.style.transform = ''
      widePanelRef.current.style.willChange = ''
    }
  }, [geometry.overlay, sidebarW])

  // Capture the elements the wide mode restyles, restoring them on exit.
  const pushed = useRef<{
    frame: HTMLElement
    margin: string
    overflow: string
    sidebar: HTMLElement | null
    sidebarPosition: string
    sidebarLeft: string
    handle: HTMLElement | null
    handleTransform: string
  } | null>(null)

  // Push the app frame right of the panel, then offset the sidebar column
  // (and its drag handle) BACK to the left edge: final order is
  // [sidebar][pdf panel][conversation]. The frame is a block-level grid, so
  // the margin shrinks it and its own ResizeObserver reflows the columns.
  useLayoutEffect(() => {
    if (!wide || geometry.overlay) return
    const frame = document.querySelector<HTMLElement>('div[style*="grid-template-columns"]')
    if (frame === null) return // degradation: overlay without reflow
    const sidebar = frame.firstElementChild instanceof HTMLElement ? frame.firstElementChild : null
    const handle = frame.querySelector<HTMLElement>('[data-side="sidebar"]')
    pushed.current = {
      frame,
      margin: frame.style.marginLeft,
      overflow: frame.style.overflow,
      sidebar,
      sidebarPosition: sidebar?.style.position ?? '',
      sidebarLeft: sidebar?.style.left ?? '',
      handle,
      handleTransform: handle?.style.transform ?? '',
    }
    return () => {
      const saved = pushed.current
      pushed.current = null
      if (saved === null) return
      saved.frame.style.marginLeft = saved.margin
      saved.frame.style.overflow = saved.overflow
      if (saved.sidebar !== null) {
        saved.sidebar.style.position = saved.sidebarPosition
        saved.sidebar.style.left = saved.sidebarLeft
      }
      if (saved.handle !== null) saved.handle.style.transform = saved.handleTransform
    }
  }, [wide, geometry.overlay])

  // (Re)apply the push geometry; runs after the capture effect above.
  useLayoutEffect(() => {
    const saved = pushed.current
    if (!wide || geometry.overlay || saved === null) return
    saved.frame.style.marginLeft = `${String(panelW)}px`
    // The frame's overflow:hidden would clip the offset sidebar (it sits
    // outside the frame's border box) — unclip while wide.
    saved.frame.style.overflow = 'visible'
    // `transform` would make the sidebar a containing block for its fixed
    // descendants, squeezing Harness's full-viewport Settings modal into the
    // sidebar width. Relative positioning moves the column without changing
    // the coordinate system used by fixed overlays.
    if (saved.sidebar !== null) {
      saved.sidebar.style.position = 'relative'
      saved.sidebar.style.left = `-${String(panelW)}px`
    }
    if (saved.handle !== null) saved.handle.style.transform = `translateX(-${String(panelW)}px)`
  }, [wide, geometry.overlay, panelW])

  // Document lifetime: load on mount, destroy on unmount; then measure page
  // 1 as the fallback size for unknown pages. Wider measured pages become the
  // fit-width reference without requiring every page proxy up front.
  useEffect(() => {
    let destroyed = false
    setInteractionMode('text')
    setInteractionNotice(undefined)
    const task = loadPdfDocument(props.bytes.slice(0))
    task.promise.then((loaded) => {
      if (destroyed) return
      setDoc(loaded)
      return loaded.getPage(1).then((page) => {
        try {
          if (!destroyed) {
            const viewport = page.getViewport({ scale: 1 })
            setBaseSize({ width: viewport.width, height: viewport.height })
          }
        } finally {
          page.cleanup()
        }
      })
    }).catch((cause: unknown) => {
      if (!destroyed) {
        setFailed(cause instanceof Error ? cause.message : String(cause))
      }
    })
    return () => {
      destroyed = true
      for (const preview of pagePreviewCacheRef.current.values()) {
        preview.width = 1
        preview.height = 1
      }
      pagePreviewCacheRef.current.clear()
      // LoadingTask.destroy() also destroys a resolved document.
      void task.destroy().catch(() => {})
    }
  }, [props.bytes])

  // pdf-lib restores the standard outline once alongside editable annotations.
  // Project that small model locally so edits appear immediately without a
  // second pdf.js outline parse or destination fan-out.
  useEffect(() => {
    const projected = pdfBookmarksToOutline(props.bookmarks)
    setOutlineItems(projected.items)
    setOutlinePages(projected.pages)
    setOutlineReady(true)
    const available = new Set(projected.items.map(item => item.id))
    setExpandedOutlineIds(previous => {
      const next = new Set([...previous].filter(id => available.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [props.bookmarks])

  useEffect(() => { setExpandedOutlineIds(new Set()) }, [props.documentId])

  // Search ownership follows the loaded pdf.js document exactly. Replacement
  // cancels work and drops the reader-local cache. A separate bounded copy of
  // derived page text is synchronized below for the session's PDF tools.
  useEffect(() => {
    searchGenerationRef.current += 1
    searchSessionRef.current = undefined
    searchLoadingRef.current = false
    searchTextCacheRef.current.clear()
    searchTextCacheUnitsRef.current = 0
    setActiveSearchHit(undefined)
    setPdfSearch(emptyPdfSearchState(doc?.numPages ?? 0))
    return () => { searchGenerationRef.current += 1 }
  }, [doc])

  useEffect(() => {
    try {
      savePdfOcrPreferences(window.localStorage, documentQuestionOcrPreferences)
    } catch {
      // The current in-memory values remain usable when storage is unavailable.
    }
  }, [documentQuestionOcrPreferences])

  // Build a bounded, derived-text index for the three host-side PDF tools.
  // Batches are awaited in order, so replacement/close cannot resurrect an
  // older document. Raw PDF bytes never cross this boundary.
  useEffect(() => {
    if (doc === undefined) return
    let cancelled = false
    const abort = new AbortController()
    const indexId = createPdfDocumentId()
    documentIndexInstanceRef.current = indexId
    props.onDocumentIndexChange(props.documentId, indexId)
    const replace = syncPdfDocumentIndex({
      action: 'replace',
      sessionId: props.sessionId,
      documentId: props.documentId,
      indexId,
      documentName: props.documentName,
      totalPages: doc.numPages,
    }, abort.signal)
    documentIndexReadyRef.current = replace
    setDocumentIndexStatus({ kind: 'indexing', indexedPages: 0, totalPages: doc.numPages })

    void (async () => {
      await replace
      // Page rendering owns the interactive path. Native-text extraction starts
      // only once the browser has an idle slice and yields after every batch.
      await waitForPdfIndexIdle(abort.signal)
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
          sessionId: props.sessionId,
          documentId: props.documentId,
          indexId,
          indexedPages,
          truncated,
          pages,
        }, abort.signal)
        if (!cancelled) setDocumentIndexStatus({ kind: 'indexing', indexedPages, totalPages: doc.numPages })
      }

      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        if (cancelled) return
        const page = await doc.getPage(pageNumber)
        let content: PdfTextContent
        try {
          content = await page.getTextContent()
        } finally {
          // getPage() is document-cached; cleanup is what releases decoded
          // page resources while this long sequential scan is still running.
          page.cleanup()
        }
        let text = pdfPageText(content.items)
        // One pathological content stream must not exceed the HTTP batch cap.
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
        const cachedUnits = searchTextCacheRef.current.get(pageNumber)?.length ?? 0
        const nextSearchCacheUnits = searchTextCacheUnitsRef.current - cachedUnits + text.length
        if (nextSearchCacheUnits <= MAX_PDF_SEARCH_CACHE_CODE_UNITS) {
          searchTextCacheRef.current.set(pageNumber, text)
          searchTextCacheUnitsRef.current = nextSearchCacheUnits
        }
        if (codeUnits >= MAX_PDF_DOCUMENT_INDEX_CODE_UNITS) {
          if (pageNumber < doc.numPages) truncated = true
          break
        }
        if (shouldStopAutomaticPdfIndex({ indexedPages, totalPages: doc.numPages, codeUnits })) {
          // A long leading run with no native text is almost certainly scanned.
          // Leave the remainder for explicit, user-authorized OCR instead of
          // decoding every image-only page in the background.
          truncated = true
          break
        }
        // Yield between worker batches so indexing does not monopolize reader interaction.
        if (pageNumber % MAX_PDF_DOCUMENT_INDEX_PAGES_PER_BATCH === 0) {
          await flush()
          await waitForPdfIndexIdle(abort.signal)
        }
      }
      await flush()
      if (cancelled) return
      await syncPdfDocumentIndex({
        action: 'complete',
        sessionId: props.sessionId,
        documentId: props.documentId,
        indexId,
        indexedPages,
        truncated,
      }, abort.signal)
      if (!cancelled) setDocumentIndexStatus({ kind: 'ready', indexedPages, totalPages: doc.numPages, truncated })
    })().catch((cause: unknown) => {
      if (cancelled || abort.signal.aborted) return
      setDocumentIndexStatus({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    })

    return () => {
      cancelled = true
      abort.abort()
    }
  }, [doc, props.documentId, props.documentName, props.onDocumentIndexChange, props.sessionId])

  // Directory rows are tiny and may resolve after text indexing starts. Each
  // complete snapshot replaces the previous one; unresolved destinations stay
  // visible without pretending to have a page number.
  useEffect(() => {
    if (doc === undefined || !outlineReady) return
    const outline: PdfDocumentIndexOutlineItem[] = outlineItems.map(item => {
      const pageNumber = outlinePages.get(item.id)
      return {
        title: item.title,
        depth: item.depth,
        ...(pageNumber === undefined ? {} : { pageNumber }),
      }
    })
    const indexId = documentIndexInstanceRef.current
    let cancelled = false
    void documentIndexReadyRef.current.then(async () => {
      if (cancelled) return
      await syncPdfDocumentIndex({
        action: 'outline',
        sessionId: props.sessionId,
        documentId: props.documentId,
        indexId,
        outline,
      })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [doc, outlineItems, outlinePages, outlineReady, props.documentId, props.sessionId])

  // Fit width follows the scroller's inner width. The scroller only EXISTS
  // after the document loads (early returns above), so this effect waits for
  // `doc` — mounting with a null ref would never attach the observer. The
  // `wide` dependency re-arms it after reopening. Do not measure the hidden
  // scroller at width 0: that would relayout its pages and clamp scroll state.
  useEffect(() => {
    if (!wide || doc === undefined) return
    const scroller = scrollerRef.current
    if (scroller === null) return
    const updateFitViewport = (width: number, height: number): void => {
      if (!(width > 0) || !(height > 0)) return
      const widthChanged = Math.abs(width - fitWidthRef.current) >= 0.5
      const heightChanged = Math.abs(height - fitHeightRef.current) >= 0.5
      if (!widthChanged && !heightChanged) return
      if (fitWidthRef.current > 0 && fitHeightRef.current > 0) {
        fitWidthAnchorRef.current = capturePageLayoutAnchor(scroller)
      }
      fitWidthRef.current = width
      fitHeightRef.current = height
      if (widthChanged) setFitWidth(width)
      if (heightChanged) setFitHeight(height)
    }
    updateFitViewport(scroller.clientWidth, scroller.clientHeight)
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect !== undefined) updateFitViewport(rect.width, rect.height)
    })
    observer.observe(scroller)
    return () => { observer.disconnect() }
  }, [doc, wide])

  // Fit-width changes resize every page and therefore every cumulative page
  // offset. Restore the same page-local point before paint; retaining the old
  // scrollTop pixels would make a long document appear to jump pages.
  useLayoutEffect(() => {
    const anchor = fitWidthAnchorRef.current
    fitWidthAnchorRef.current = undefined
    const scroller = scrollerRef.current
    if (anchor !== undefined && scroller !== null) restorePageLayoutAnchor(scroller, anchor)
  }, [fitHeight, fitMode, fitWidth])

  // Rotation swaps page axes and may change the global fit scale. Restore the
  // same source-content point in the first committed rotated layout.
  useLayoutEffect(() => {
    const anchor = rotationAnchorRef.current
    rotationAnchorRef.current = undefined
    const scroller = scrollerRef.current
    if (anchor !== undefined && scroller !== null) restorePageLayoutAnchor(scroller, anchor)
  }, [rotationRevision])

  // A restored page-local point waits until the real viewport has a fit
  // geometry, then aligns twice so the bounded page window can settle.
  useLayoutEffect(() => {
    const anchor = initialReadingAnchorRef.current
    const scroller = scrollerRef.current
    if (anchor === undefined || scroller === null || doc === undefined || !wide || fitWidth <= 0 || fitHeight <= 0) return
    initialReadingAnchorRef.current = undefined
    const align = (): void => {
      restorePageLayoutAnchor(scroller, {
        ...anchor,
        viewportX: scroller.clientWidth / 2,
        viewportY: scroller.clientHeight / 2,
      })
    }
    align()
    requestAnimationFrame(() => { requestAnimationFrame(align) })
  }, [doc, fitHeight, fitWidth, wide])

  const updateCurrentPageFromViewport = useCallback((): void => {
    if (zoomGestureActiveRef.current) return
    const scroller = scrollerRef.current
    const content = contentRef.current
    const pages = pageStackLayoutRef.current.pages
    if (scroller === null || content === null || pages.length === 0) return
    const scrollerRect = scroller.getBoundingClientRect()
    const contentRect = content.getBoundingClientRect()
    const committedZoom = zoomRef.current
    if (!(committedZoom > 0)) return
    const viewportTop = (scrollerRect.top - contentRect.top) / committedZoom
    const visiblePage = visiblePdfPageNumber(pages, viewportTop, scroller.clientHeight / committedZoom)
    if (visiblePage !== undefined) {
      setCurrentPage(previous => previous === visiblePage ? previous : visiblePage)
    }
  }, [])

  /** Commit one discrete zoom while preserving the page point under the mouse. */
  const commitAnchoredZoom = useCallback((requestedZoom: number): void => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (scroller === null || content === null || zoomSizerRef.current === null) return
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
    const previousZoom = zoomGestureActiveRef.current ? gestureZoomRef.current : zoomRef.current
    const nextZoom = Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, requestedZoom))
    if (nextZoom === previousZoom) return
    const scrollerRect = scroller.getBoundingClientRect()
    const point = pointerZoomAnchorRef.current ?? {
      x: scrollerRect.left + scroller.clientWidth / 2,
      y: scrollerRect.top + scroller.clientHeight / 2,
    }
    const beforeRect = content.getBoundingClientRect()
    const localX = (point.x - beforeRect.left) / previousZoom
    const localY = (point.y - beforeRect.top) / previousZoom
    applyZoomGeometry(nextZoom)
    const afterRect = content.getBoundingClientRect()
    scroller.scrollLeft += afterRect.left + localX * nextZoom - point.x
    scroller.scrollTop += afterRect.top + localY * nextZoom - point.y

    // The imperative geometry and refs already represent the final value;
    // React receives the same value and cannot introduce a settle snap.
    zoomRef.current = nextZoom
    gestureZoomRef.current = nextZoom
    zoomGestureActiveRef.current = false
    if (zoomSpanRef.current !== null) {
      zoomSpanRef.current.textContent = `${String(Math.round(nextZoom * 100))}%`
    }
    setZoom(nextZoom)
    requestAnimationFrame(updateCurrentPageFromViewport)
  }, [applyZoomGeometry, updateCurrentPageFromViewport])

  const changeFitMode = useCallback((mode: PdfFitMode): void => {
    setFitMenuOpen(false)
    if (mode === fitMode) {
      commitAnchoredZoom(1)
      return
    }
    const scroller = scrollerRef.current
    if (scroller !== null) fitWidthAnchorRef.current = capturePageLayoutAnchor(scroller)
    applyZoomGeometry(1)
    zoomRef.current = 1
    gestureZoomRef.current = 1
    zoomGestureActiveRef.current = false
    if (zoomSpanRef.current !== null) zoomSpanRef.current.textContent = '100%'
    setZoom(1)
    setRenderZoom(1)
    setFitMode(mode)
  }, [applyZoomGeometry, commitAnchoredZoom, fitMode])

  // React receives only the final gesture value. Its geometry is identical to
  // the imperative values already on the two zoom surfaces, so this commit
  // cannot move the point under the pointer.
  useLayoutEffect(() => {
    zoomRef.current = zoom
    gestureZoomRef.current = zoom
    zoomGestureActiveRef.current = false
    requestAnimationFrame(updateCurrentPageFromViewport)
  }, [updateCurrentPageFromViewport, zoom])

  // Pinch (trackpad) and ctrl+wheel zoom, IMPERATIVE during the gesture: a
  // React commit per wheel tick cannot keep up with a 60Hz event stream over
  // a hundreds-of-pages tree (corrections visibly lagged and snapped back).
  // So mid-gesture we touch exactly two elements: the outer sizer owns the
  // scaled scroll range, while the stable page stack is compositor-scaled.
  // No page slot changes size and the pointer anchor is restored from the
  // transformed content's actual before/after rectangles.
  useEffect(() => {
    if (!wide || doc === undefined) return
    const scroller = scrollerRef.current
    if (scroller === null) return
    const onWheel = (event: WheelEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const content = contentRef.current
      if (content === null || zoomSizerRef.current === null) return
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current)
      if (!zoomGestureActiveRef.current) {
        gestureZoomRef.current = zoomRef.current
        zoomGestureActiveRef.current = true
      }
      // 0.008/px with a per-event cap: trackpad pinches (small deltas, high
      // frequency) feel native; mouse notches (deltaY≈120) cap at 1.6x each.
      const factor = Math.min(1.6, Math.max(1 / 1.6, Math.exp(-event.deltaY * 0.008)))
      const previousZoom = gestureZoomRef.current
      const gesture = Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, gestureZoomRef.current * factor))
      gestureZoomRef.current = gesture
      if (gesture !== previousZoom) {
        const beforeRect = content.getBoundingClientRect()
        const localX = (event.clientX - beforeRect.left) / previousZoom
        const localY = (event.clientY - beforeRect.top) / previousZoom
        applyZoomGeometry(gesture)
        // Reading the new rectangle admits the sizer's new overflow and its
        // horizontal auto-margin before the anchor correction is written.
        const afterRect = content.getBoundingClientRect()
        scroller.scrollLeft += afterRect.left + localX * gesture - event.clientX
        scroller.scrollTop += afterRect.top + localY * gesture - event.clientY
      }
      if (zoomSpanRef.current !== null) {
        zoomSpanRef.current.textContent = `${String(Math.round(gesture * 100))}%`
      }
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null
        const gesture = gestureZoomRef.current
        if (gesture === zoomRef.current) {
          zoomGestureActiveRef.current = false
          requestAnimationFrame(updateCurrentPageFromViewport)
          return
        }
        setZoom(gesture)
      }, 180)
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      scroller.removeEventListener('wheel', onWheel)
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current)
        settleTimerRef.current = null
      }
      if (zoomGestureActiveRef.current) {
        applyZoomGeometry(zoomRef.current)
        gestureZoomRef.current = zoomRef.current
        zoomGestureActiveRef.current = false
        if (zoomSpanRef.current !== null) {
          zoomSpanRef.current.textContent = `${String(Math.round(zoomRef.current * 100))}%`
        }
      }
    }
  }, [applyZoomGeometry, doc, updateCurrentPageFromViewport, wide])

  // Current-page tracking reads the immutable geometry array instead of
  // observing one DOM node per page. A binary search plus the handful of
  // actually visible pages bounds every scroll update independently of the
  // document's page count.
  useEffect(() => {
    if (doc === undefined) return
    const scroller = scrollerRef.current
    if (scroller === null) return
    let raf: number | null = null
    const schedule = (): void => {
      if (zoomGestureActiveRef.current) return
      raf ??= requestAnimationFrame(() => {
        raf = null
        updateCurrentPageFromViewport()
        const anchor = capturePageLayoutAnchor(scroller)
        if (anchor !== undefined) {
          setReadingAnchor(current => (
            current.pageNumber === anchor.pageNumber
              && Math.abs(current.pageXRatio - anchor.pageXRatio) < 0.0005
              && Math.abs(current.pageYRatio - anchor.pageYRatio) < 0.0005
              ? current
              : {
                  pageNumber: anchor.pageNumber,
                  pageXRatio: anchor.pageXRatio,
                  pageYRatio: anchor.pageYRatio,
                }
          ))
        }
      })
    }
    scroller.addEventListener('scroll', schedule, { passive: true })
    schedule()
    return () => {
      scroller.removeEventListener('scroll', schedule)
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [doc, updateCurrentPageFromViewport])

  /** Scroll one page into view (1-based; clamped to the document). */
  const gotoPage = useCallback((page: number): void => {
    if (doc === undefined) return
    const target = Math.min(doc.numPages, Math.max(1, Math.round(page)))
    const scroller = scrollerRef.current
    const geometry = pageStackLayoutRef.current.pages[target - 1]
    setCurrentPage(target)
    if (scroller !== null && geometry !== undefined) {
      scroller.scrollTop = geometry.top * zoomRef.current
    }
  }, [doc])

  // Keep the shortcut surface deliberately small. Search is global while the
  // reader is open; zoom yields to text entry, while Space also preserves
  // native button/link activation so the host UI retains keyboard ownership.
  useEffect(() => {
    if (!wide || doc === undefined) return
    const focusSearchInput = (): void => {
      let attempts = 0
      const focus = (): void => {
        const input = [...document.querySelectorAll<HTMLInputElement>('[data-pdf-search-input="true"]')]
          .find(candidate => candidate.getClientRects().length > 0)
        if (input !== undefined) {
          input.focus()
          input.select()
          return
        }
        attempts += 1
        if (attempts < 8) requestAnimationFrame(focus)
      }
      requestAnimationFrame(focus)
    }
    const onShortcut = (event: KeyboardEvent): void => {
      const searchShortcut = (event.ctrlKey || event.metaKey)
        && !event.altKey
        && (event.key.toLowerCase() === 'f' || event.code === 'KeyF')
      if (searchShortcut) {
        event.preventDefault()
        event.stopPropagation()
        let opened: boolean
        if (geometry.overlay) {
          opened = navigationDrawer !== 'search'
          setNavigationDrawer(opened ? 'search' : undefined)
        } else {
          opened = props.onSearchToggle()
        }
        if (opened) focusSearchInput()
        return
      }
      if (event.defaultPrevented || event.isComposing
        || event.ctrlKey || event.metaKey || event.altKey) return

      const space = event.key === ' ' || event.code === 'Space'
      const zoomIn = event.key === '+' || event.code === 'NumpadAdd'
        || (event.code === 'Equal' && event.shiftKey)
      const zoomOut = event.key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract'
      const resetZoom = event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0'
      if (space && !isPdfShortcutSpaceTarget(event.target)) {
        event.preventDefault()
        event.stopPropagation()
        gotoPage(currentPage + 1)
      } else if (zoomIn && !isPdfShortcutTextEntryTarget(event.target)) {
        event.preventDefault()
        event.stopPropagation()
        const current = zoomGestureActiveRef.current ? gestureZoomRef.current : zoomRef.current
        commitAnchoredZoom(current + PDF_ZOOM_STEP)
      } else if (zoomOut && !isPdfShortcutTextEntryTarget(event.target)) {
        event.preventDefault()
        event.stopPropagation()
        const current = zoomGestureActiveRef.current ? gestureZoomRef.current : zoomRef.current
        commitAnchoredZoom(current - PDF_ZOOM_STEP)
      } else if (resetZoom && !isPdfShortcutTextEntryTarget(event.target)) {
        event.preventDefault()
        event.stopPropagation()
        commitAnchoredZoom(1)
      }
    }
    window.addEventListener('keydown', onShortcut, { capture: true })
    return () => { window.removeEventListener('keydown', onShortcut, { capture: true }) }
  }, [commitAnchoredZoom, currentPage, doc, geometry.overlay, gotoPage, navigationDrawer, props.onSearchToggle, wide])

  const updateNavigationAvailability = useCallback((): void => {
    setNavigationAvailability({
      back: navigationBackRef.current.length > 0,
      forward: navigationForwardRef.current.length > 0,
    })
  }, [])

  /** Only explicit page/outline/search jumps enter history; passive view changes do not. */
  const rememberNavigationOrigin = useCallback((): void => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    const anchor = capturePageLayoutAnchor(scroller)
    if (anchor === undefined) return
    const location: PdfNavigationLocation = {
      pageNumber: anchor.pageNumber,
      pageXRatio: anchor.pageXRatio,
      pageYRatio: anchor.pageYRatio,
      rotation: rotationForPage(anchor.pageNumber),
    }
    navigationBackRef.current = [
      ...navigationBackRef.current.slice(-(MAX_PDF_NAVIGATION_HISTORY - 1)),
      location,
    ]
    // A new branch makes the old forward path unreachable, matching browser history.
    navigationForwardRef.current = []
    updateNavigationAvailability()
  }, [rotationForPage, updateNavigationAvailability])

  const navigateToPage = useCallback((page: number): void => {
    rememberNavigationOrigin()
    gotoPage(page)
  }, [gotoPage, rememberNavigationOrigin])

  const restoreNavigationLocation = useCallback((location: PdfNavigationLocation): void => {
    const align = (): void => {
      const scroller = scrollerRef.current
      if (scroller !== null) {
        restorePdfNavigationLocation(scroller, location, rotationForPage(location.pageNumber))
      }
    }
    setCurrentPage(location.pageNumber)
    align()
    // Re-align after the target enters the bounded canvas window and its
    // measured geometry replaces the lightweight placeholder.
    requestAnimationFrame(() => { requestAnimationFrame(align) })
  }, [rotationForPage])

  const traverseNavigationHistory = useCallback((direction: 'back' | 'forward'): void => {
    const source = direction === 'back' ? navigationBackRef : navigationForwardRef
    const destination = direction === 'back' ? navigationForwardRef : navigationBackRef
    const target = source.current.at(-1)
    const scroller = scrollerRef.current
    if (target === undefined || scroller === null) return
    const anchor = capturePageLayoutAnchor(scroller)
    const current: PdfNavigationLocation | undefined = anchor === undefined ? undefined : {
      pageNumber: anchor.pageNumber,
      pageXRatio: anchor.pageXRatio,
      pageYRatio: anchor.pageYRatio,
      rotation: rotationForPage(anchor.pageNumber),
    }
    if (current === undefined) return

    source.current = source.current.slice(0, -1)
    destination.current = [
      ...destination.current.slice(-(MAX_PDF_NAVIGATION_HISTORY - 1)),
      current,
    ]
    updateNavigationAvailability()
    restoreNavigationLocation(target)
  }, [restoreNavigationLocation, rotationForPage, updateNavigationAvailability])

  const cancelPdfSearch = useCallback((): void => {
    searchGenerationRef.current += 1
    searchLoadingRef.current = false
    setPdfSearch(previous => previous.status === 'running'
      ? { ...previous, status: 'cancelled' }
      : previous)
  }, [])

  const continuePdfSearch = useCallback((session: PdfSearchSession): void => {
    if (doc === undefined || searchLoadingRef.current) return
    const generation = searchGenerationRef.current + 1
    searchGenerationRef.current = generation
    searchLoadingRef.current = true
    const batchTarget = Math.min(
      MAX_PDF_SEARCH_TOTAL_RESULTS,
      session.results.length + MAX_PDF_SEARCH_RESULTS,
    )
    setPdfSearch(pdfSearchStateFromSession(doc.numPages, session, 'running'))

    void (async () => {
      while (session.nextPage <= doc.numPages) {
        const firstPage = session.nextPage
        const pageNumbers = Array.from(
          { length: Math.min(PDF_SEARCH_CONCURRENCY, doc.numPages - firstPage + 1) },
          (_, index) => firstPage + index,
        )
        const pages = await Promise.all(pageNumbers.map(async (pageNumber) => {
          const cached = searchTextCacheRef.current.get(pageNumber)
          if (cached !== undefined) return { pageNumber, text: cached, failed: false }
          let page: PDFPageProxy | undefined
          try {
            page = await doc.getPage(pageNumber)
            const content = await page.getTextContent()
            const text = pdfPageText(content.items)
            if (searchTextCacheUnitsRef.current + text.length <= MAX_PDF_SEARCH_CACHE_CODE_UNITS) {
              searchTextCacheRef.current.set(pageNumber, text)
              searchTextCacheUnitsRef.current += text.length
            }
            return { pageNumber, text, failed: false }
          } catch {
            return { pageNumber, text: '', failed: true }
          } finally {
            page?.cleanup()
          }
        }))
        if (searchGenerationRef.current !== generation) return

        for (const page of pages) {
          session.scannedPages = page.pageNumber
          if (page.failed) session.failedPages += 1
          if (page.text.length > 0) session.hasSearchableText = true
          const remaining = batchTarget - session.results.length
          const skip = page.pageNumber === session.nextPage ? session.pageMatchOffset : 0
          const matches = findPdfTextMatches(page.text, session.query, page.pageNumber, remaining, skip)
          session.results.push(...matches)

          if (session.results.length >= batchTarget) {
            // Exact exhaustion is intentionally resolved by the next lazy
            // batch. Retaining this page cursor avoids dropping occurrences.
            session.nextPage = page.pageNumber
            session.pageMatchOffset = skip + matches.length
            const atTotalLimit = session.results.length >= MAX_PDF_SEARCH_TOTAL_RESULTS
            // Publish the paused state only after releasing the in-flight
            // guard, so an already-visible bottom sentinel can resume it.
            searchLoadingRef.current = false
            setPdfSearch(pdfSearchStateFromSession(
              doc.numPages,
              session,
              atTotalLimit ? 'done' : 'paused',
              atTotalLimit,
            ))
            return
          }
          session.nextPage = page.pageNumber + 1
          session.pageMatchOffset = 0
        }

        setPdfSearch(pdfSearchStateFromSession(doc.numPages, session, 'running'))
        // Cached repeat searches must still yield so Cancel and a newer query
        // can invalidate this generation between bounded worker batches.
        await new Promise<void>(resolve => { window.setTimeout(resolve, 0) })
        if (searchGenerationRef.current !== generation) return
      }
      setPdfSearch(pdfSearchStateFromSession(doc.numPages, session, 'done'))
    })().catch((cause: unknown) => {
      if (searchGenerationRef.current !== generation) return
      setPdfSearch(previous => ({
        ...previous,
        status: 'error',
        error: cause instanceof Error ? cause.message : String(cause),
      }))
    }).finally(() => {
      if (searchGenerationRef.current === generation) searchLoadingRef.current = false
    })
  }, [doc])

  const loadMorePdfSearch = useCallback((): void => {
    const session = searchSessionRef.current
    if (session === undefined || pdfSearch.status !== 'paused') return
    continuePdfSearch(session)
  }, [continuePdfSearch, pdfSearch.status])

  const clearPdfSearch = useCallback((): void => {
    searchGenerationRef.current += 1
    searchLoadingRef.current = false
    searchSessionRef.current = undefined
    setActiveSearchHit(undefined)
    setPdfSearch(emptyPdfSearchState(doc?.numPages ?? 0))
  }, [doc])

  const runPdfSearch = useCallback((rawQuery: string): void => {
    if (doc === undefined) return
    if (isBlankPdfSearchQuery(rawQuery)) {
      clearPdfSearch()
      return
    }
    const query = rawQuery.trim()
    searchGenerationRef.current += 1
    searchLoadingRef.current = false
    searchSessionRef.current = undefined
    setActiveSearchHit(undefined)
    if (query.length > MAX_PDF_SEARCH_QUERY_LENGTH) {
      setPdfSearch({
        ...emptyPdfSearchState(doc.numPages),
        query,
        status: 'error',
        error: `搜索文字不能超过 ${String(MAX_PDF_SEARCH_QUERY_LENGTH)} 个字符`,
      })
      return
    }
    const session: PdfSearchSession = {
      query,
      nextPage: 1,
      pageMatchOffset: 0,
      results: [],
      scannedPages: 0,
      failedPages: 0,
      hasSearchableText: false,
    }
    searchSessionRef.current = session
    continuePdfSearch(session)
  }, [clearPdfSearch, continuePdfSearch, doc])

  // A hidden reader has no visible cancellation control. Stop active work but
  // retain its partial results so reopening explains where the scan ended.
  useEffect(() => {
    if (!wide && pdfSearch.status === 'running') cancelPdfSearch()
  }, [cancelPdfSearch, pdfSearch.status, wide])

  const navigatePdfSearchResult = useCallback((result: PdfSearchResult): void => {
    setActiveSearchHit({ query: pdfSearch.query, result })
    navigateToPage(result.pageNumber)
  }, [navigateToPage, pdfSearch.query])
  const clearPdfSearchHighlight = useCallback((): void => {
    setActiveSearchHit(undefined)
  }, [])

  // The narrow drawer is local to this viewer. Whichever action closes it or
  // switches to the outline, leaving search mode also ends its visual hit.
  useLayoutEffect(() => {
    const previous = previousNavigationDrawerRef.current
    previousNavigationDrawerRef.current = navigationDrawer
    if (previous === 'search' && navigationDrawer !== 'search') {
      clearPdfSearchHighlight()
    }
  }, [clearPdfSearchHighlight, navigationDrawer])

  const navigateOutline = useCallback((id: string): void => {
    const item = outlineItems.find(candidate => candidate.id === id)
    if (item === undefined || !item.navigable) return
    setSelectionError(undefined)
    const knownPage = outlinePages.get(id)
    if (knownPage !== undefined) {
      navigateToPage(knownPage)
      return
    }
    const url = props.bookmarks.find(bookmark => bookmark.id === id)?.url
    if (url !== undefined && isSafeExternalPdfBookmarkUrl(url)) {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }, [navigateToPage, outlineItems, outlinePages, props.bookmarks])

  const expandableOutlineIds = useMemo(
    () => new Set(outlineItems.filter(item => item.hasChildren).map(item => item.id)),
    [outlineItems],
  )
  const toggleOutlineExpanded = useCallback((id: string): void => {
    if (!expandableOutlineIds.has(id)) return
    setExpandedOutlineIds(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [expandableOutlineIds])
  const setAllOutlineExpanded = useCallback((expanded: boolean): void => {
    setExpandedOutlineIds(expanded ? new Set(expandableOutlineIds) : new Set())
  }, [expandableOutlineIds])

  const currentOutlineItemId = useMemo(
    () => currentPdfOutlineItemId(outlineItems, outlinePages, currentPage),
    [currentPage, outlineItems, outlinePages],
  )
  const visibleCurrentOutlineItemId = useMemo(
    () => visibleCurrentPdfOutlineItemId(outlineItems, expandedOutlineIds, currentOutlineItemId),
    [currentOutlineItemId, expandedOutlineIds, outlineItems],
  )
  const revealCurrentOutline = useCallback((): void => {
    if (currentOutlineItemId === undefined) return
    const ancestors = pdfOutlineAncestorIds(outlineItems, currentOutlineItemId)
    setExpandedOutlineIds(previous => {
      const next = new Set(previous)
      let changed = false
      for (const id of ancestors) {
        if (!next.has(id)) {
          next.add(id)
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [currentOutlineItemId, outlineItems])

  // Search progress republishes the controller every four pages; retain one
  // destination-free outline projection instead of reallocating up to 2,000
  // row objects on every progress update.
  const publicOutlineItems = useMemo(
    () => outlineItems.map(({ destination: _destination, ...item }) => item),
    [outlineItems],
  )

  const outlineController = useMemo<PdfOutlineController | undefined>(() => {
    if (!outlineReady) return undefined
    return {
      documentName: props.documentName,
      items: publicOutlineItems,
      expandedIds: expandedOutlineIds,
      search: {
        state: pdfSearch,
        run: runPdfSearch,
        clear: clearPdfSearch,
        loadMore: loadMorePdfSearch,
        cancel: cancelPdfSearch,
        navigate: navigatePdfSearchResult,
        clearHighlight: clearPdfSearchHighlight,
      },
      currentItemId: currentOutlineItemId,
      visibleCurrentItemId: visibleCurrentOutlineItemId,
      currentPage,
      totalPages: doc?.numPages ?? 0,
      editable: true,
      toggleExpanded: toggleOutlineExpanded,
      setAllExpanded: setAllOutlineExpanded,
      revealCurrent: revealCurrentOutline,
      navigate: navigateOutline,
      addBookmark: (draft) => {
        props.onBookmarkAdd(draft)
        const parentId = draft.parentId
        if (parentId !== null) setExpandedOutlineIds(previous => new Set(previous).add(parentId))
      },
      updateBookmark: props.onBookmarkUpdate,
      removeBookmark: props.onBookmarkRemove,
    }
  }, [cancelPdfSearch, clearPdfSearch, clearPdfSearchHighlight, currentOutlineItemId, currentPage, doc?.numPages, expandedOutlineIds, loadMorePdfSearch, navigateOutline, navigatePdfSearchResult, outlineReady, pdfSearch, props.documentName, props.onBookmarkAdd, props.onBookmarkRemove, props.onBookmarkUpdate, publicOutlineItems, revealCurrentOutline, runPdfSearch, setAllOutlineExpanded, toggleOutlineExpanded, visibleCurrentOutlineItemId])

  // Desktop publishes into the Harness sidebar. In the existing narrow
  // full-viewport fallback the sidebar is covered, so the same controller is
  // rendered locally as a drawer instead.
  useEffect(() => {
    const published = wide && !geometry.overlay ? outlineController : undefined
    props.onOutlineChange(published)
  }, [geometry.overlay, outlineController, props.onOutlineChange, wide])
  // Controller revisions (for example one expanded branch) replace the live
  // value in place. Only component teardown needs a release; treating every
  // effect revision as teardown would close the sidebar between two values.
  useEffect(() => () => { props.onOutlineChange(undefined) }, [props.onOutlineChange])
  useEffect(() => {
    if (!wide || !geometry.overlay || outlineController === undefined) setNavigationDrawer(undefined)
  }, [geometry.overlay, outlineController, wide])

  const clearEvidenceHighlight = (): void => {
    if (evidenceHighlightTimerRef.current !== undefined) {
      window.clearTimeout(evidenceHighlightTimerRef.current)
      evidenceHighlightTimerRef.current = undefined
    }
    setActiveEvidenceText(undefined)
    setActiveEvidenceImage(undefined)
  }

  /** Center one normalized crop in the reader, mounting its page window. */
  const gotoSelection = (
    selection: Pick<SelectionInfo, 'pageNumber' | 'rect' | 'rotation'>,
    flash = false,
  ): void => {
    clearEvidenceHighlight()
    if (flash) {
      const target: PdfCitationImageTarget = {
        pageNumber: selection.pageNumber,
        rect: selection.rect,
        rotation: selection.rotation,
      }
      setActiveEvidenceImage(target)
      setEvidenceHighlightRevision(revision => revision + 1)
      evidenceHighlightTimerRef.current = window.setTimeout(() => {
        evidenceHighlightTimerRef.current = undefined
        setActiveEvidenceImage(current => current === target ? undefined : current)
      }, 2500)
    }
    rememberNavigationOrigin()
    const align = (): void => {
      const scroller = scrollerRef.current
      const page = scroller?.querySelector<HTMLElement>(`div[data-page="${String(selection.pageNumber)}"]`)
      if (scroller === null || scroller === undefined || page === null || page === undefined) return
      const scrollerRect = scroller.getBoundingClientRect()
      const pageRect = page.getBoundingClientRect()
      const rect = rotateNormalizedPdfRect(
        selection.rect,
        normalizePdfRotation(rotationForPage(selection.pageNumber) - selection.rotation),
      )
      const targetX = pageRect.left + pageRect.width * (rect.x + rect.width / 2)
      const targetY = pageRect.top + pageRect.height * (rect.y + rect.height / 2)
      scroller.scrollLeft += targetX - (scrollerRect.left + scroller.clientWidth / 2)
      scroller.scrollTop += targetY - (scrollerRect.top + scroller.clientHeight / 2)
    }
    if (geometry.overlay) setEvidenceDrawerOpen(false)
    setCurrentPage(selection.pageNumber)
    align()
    // Re-align after the target page enters the bounded canvas window and its
    // measured size replaces the lightweight fallback geometry.
    requestAnimationFrame(() => { requestAnimationFrame(align) })
  }

  /** Center the first native-text fragment retained in the temporary evidence basket. */
  const gotoTextEvidence = (source: PdfTextEvidence): void => {
    const draft = source.drafts[0]
    const canonicalRect = draft?.rects[0]
    if (draft === undefined || canonicalRect === undefined) return
    clearEvidenceHighlight()
    setActiveEvidenceText(source)
    setEvidenceHighlightRevision(revision => revision + 1)
    evidenceHighlightTimerRef.current = window.setTimeout(() => {
      evidenceHighlightTimerRef.current = undefined
      setActiveEvidenceText(current => current === source ? undefined : current)
    }, 2500)
    rememberNavigationOrigin()
    const align = (): void => {
      const scroller = scrollerRef.current
      const page = scroller?.querySelector<HTMLElement>(`div[data-page="${String(draft.pageNumber)}"]`)
      if (scroller === null || scroller === undefined || page === null || page === undefined) return
      const scrollerRect = scroller.getBoundingClientRect()
      const pageRect = page.getBoundingClientRect()
      const rect = rotateNormalizedPdfRect(canonicalRect, rotationForPage(draft.pageNumber))
      const targetX = pageRect.left + pageRect.width * (rect.x + rect.width / 2)
      const targetY = pageRect.top + pageRect.height * (rect.y + rect.height / 2)
      scroller.scrollLeft += targetX - (scrollerRect.left + scroller.clientWidth / 2)
      scroller.scrollTop += targetY - (scrollerRect.top + scroller.clientHeight / 2)
    }
    if (geometry.overlay) setEvidenceDrawerOpen(false)
    setCurrentPage(draft.pageNumber)
    align()
    requestAnimationFrame(() => { requestAnimationFrame(align) })
  }

  /** Jump to one tool-returned text offset and reuse the precise search overlay. */
  const gotoDocumentCitation = (source: Extract<PdfCitationTarget, { kind: 'document' }>['source']): void => {
    setEvidenceDrawerOpen(false)
    setActiveSearchHit(source.endOffset > source.offset
      ? {
          query: '',
          result: {
            pageNumber: source.pageNumber,
            offset: source.offset,
            endOffset: source.endOffset,
            snippet: '',
          },
        }
      : undefined)
    navigateToPage(source.pageNumber)
  }

  useEffect(() => {
    const navigation = props.citationNavigation
    if (navigation === undefined) return
    setEvidenceDrawerOpen(false)
    if (navigation.target.kind === 'image') gotoSelection(navigation.target.source, true)
    else if (navigation.target.kind === 'text') gotoTextEvidence(navigation.target.source)
    else gotoDocumentCitation(navigation.target.source)
  // The monotonically increasing revision intentionally replays an identical citation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.citationNavigation?.revision])

  /** Center the first fragment of one logical markup while retaining the list for comparison. */
  const gotoAnnotation = useCallback((annotation: PdfTextMarkupAnnotation): void => {
    const canonicalRect = annotation.rects[0]
    if (canonicalRect === undefined) return
    rememberNavigationOrigin()
    const align = (): void => {
      const scroller = scrollerRef.current
      const page = scroller?.querySelector<HTMLElement>(`div[data-page="${String(annotation.pageNumber)}"]`)
      if (scroller === null || scroller === undefined || page === null || page === undefined) return
      const scrollerRect = scroller.getBoundingClientRect()
      const pageRect = page.getBoundingClientRect()
      const rect = rotateNormalizedPdfRect(canonicalRect, rotationForPage(annotation.pageNumber))
      const targetX = pageRect.left + pageRect.width * (rect.x + rect.width / 2)
      const targetY = pageRect.top + pageRect.height * (rect.y + rect.height / 2)
      scroller.scrollLeft += targetX - (scrollerRect.left + scroller.clientWidth / 2)
      scroller.scrollTop += targetY - (scrollerRect.top + scroller.clientHeight / 2)
    }
    if (geometry.overlay) setAnnotationDrawerOpen(false)
    setCurrentPage(annotation.pageNumber)
    align()
    requestAnimationFrame(() => { requestAnimationFrame(align) })
  }, [geometry.overlay, rememberNavigationOrigin, rotationForPage])

  const handleSelection = useCallback((next: SelectionInfo, anchor: ClientRectSnapshot): void => {
    setSelectionError(undefined)
    try {
      props.onSelectionAdd(next)
      setAnnotationMenu(undefined)
      setImageAiQuestionDraft('')
      setImageAiQuestionOpen(false)
      setImageAiMenu({ selection: next, anchor })
    } catch (cause) {
      setSelectionError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [props.onSelectionAdd])

  const handleTextUnavailable = useCallback((pageNumber: number): void => {
    if (interactionNoticeTimerRef.current !== undefined) {
      window.clearTimeout(interactionNoticeTimerRef.current)
    }
    setInteractionNotice(`第 ${String(pageNumber)} 页没有可选择的文字，可切换到区域截图`)
    interactionNoticeTimerRef.current = window.setTimeout(() => {
      interactionNoticeTimerRef.current = undefined
      setInteractionNotice(undefined)
    }, 3000)
  }, [])

  const replaceButton = (
    <PdfToolbarButton
      iconOnly
      aria-label={props.replaceBusy ? '正在打开 PDF' : '打开另一份 PDF'}
      title={props.replaceBusy ? '正在打开 PDF' : '打开另一份 PDF'}
      disabled={props.replaceBusy}
      onClick={props.onReplace}
    >
      <ReplacePdfIcon />
    </PdfToolbarButton>
  )
  const saveButton = (
    <div ref={saveMenuRef} style={styles.selectionMenuAnchor}>
      <PdfToolbarButton
        iconOnly
        data-pdf-save-menu-button="true"
        aria-haspopup="menu"
        aria-expanded={saveMenuOpen}
        aria-label={props.saveBusy === undefined ? '保存 PDF' : '正在保存 PDF'}
        title={props.editorDirty ? '保存批注或书签到 PDF' : '另存 PDF 或覆盖原文件'}
        disabled={props.saveBusy !== undefined}
        onClick={() => {
          setFitMenuOpen(false)
          setRotationMenuOpen(false)
          setEvidenceDrawerOpen(false)
          setSaveMenuOpen(open => !open)
        }}
      >
        <SavePdfIcon />
      </PdfToolbarButton>
      {saveMenuOpen && (
        <div data-pdf-save-menu="true" role="menu" aria-label="保存 PDF" style={{ ...styles.rotationMenu, minWidth: '230px' }}>
          <button
            data-pdf-save-as="true"
            type="button"
            role="menuitem"
            disabled={props.saveBusy !== undefined}
            style={{ ...styles.rotationMenuItem, opacity: props.saveBusy === undefined ? 1 : 0.5 }}
            onClick={() => {
              setSaveMenuOpen(false)
              void props.onSaveAs()
            }}
          >
            {props.saveBusy === 'save-as' ? '正在另存…' : '另存为…'}
          </button>
          <div aria-hidden="true" style={styles.rotationMenuDivider} />
          <button
            data-pdf-overwrite="true"
            type="button"
            role="menuitem"
            disabled={!props.canOverwrite || !props.editorDirty || props.saveBusy !== undefined}
            title={!props.canOverwrite
              ? '当前文件没有可写句柄，请先使用“另存为”'
              : !props.editorDirty
                ? '当前没有尚未保存的批注或书签改动'
                : '覆盖当前 PDF 文件'}
            style={{
              ...styles.rotationMenuItem,
              opacity: props.canOverwrite && props.editorDirty && props.saveBusy === undefined ? 1 : 0.45,
              cursor: props.canOverwrite && props.editorDirty && props.saveBusy === undefined ? 'pointer' : 'not-allowed',
            }}
            onClick={() => {
              if (!props.canOverwrite || !props.editorDirty || props.saveBusy !== undefined) return
              const confirmed = window.confirm(
                `将把当前批注和书签写入并覆盖“${props.documentName}”。此操作会重写 PDF，且可能使已有数字签名失效。是否继续？`,
              )
              if (!confirmed) return
              setSaveMenuOpen(false)
              void props.onOverwrite()
            }}
          >
            {props.saveBusy === 'overwrite' ? '正在覆盖…' : '覆盖原文件'}
          </button>
          {!props.canOverwrite && (
            <div style={{ padding: '5px 8px 2px', color: '#8c8c8c', fontSize: '11px', lineHeight: 1.45 }}>
              当前打开方式未授予写入权限；另存后可继续覆盖该副本。
            </div>
          )}
        </div>
      )}
    </div>
  )
  const selectedQuestionDocuments = props.documents.filter(document => documentQuestionSelectedIds.has(document.documentId))
  const documentQuestionTitle = documentIndexStatus.kind === 'indexing'
    ? `询问 PDF（当前文档原生文字索引进行中：${String(documentIndexStatus.indexedPages)}/${String(documentIndexStatus.totalPages)} 页，可立即提问）`
    : documentIndexStatus.kind === 'ready'
      ? documentIndexStatus.truncated
        ? '询问 PDF（当前文档索引为部分范围，回答会标明范围）'
        : '询问 PDF'
      : `当前 PDF 索引不可用：${documentIndexStatus.message}`
  const documentQuestionOcrAboveDefault = documentQuestionOcrPreferences.maxOcrPages > PDF_OCR_DEFAULT_PAGE_BUDGET
    || documentQuestionOcrPreferences.maxVisualPages > PDF_OCR_DEFAULT_VISUAL_BUDGET
    || documentQuestionOcrPreferences.maxPagesPerBatch > PDF_OCR_DEFAULT_PAGES_PER_BATCH
  const submitDocumentQuestion = (): void => {
    if (documentQuestionBusy || selectedQuestionDocuments.length === 0) return
    const question = documentQuestionDraft.trim()
    if (question.length === 0) return
    setSelectionError(undefined)
    setDocumentQuestionBusy(true)
    void (async () => {
      await props.onDocumentsQuestion(
        question,
        selectedQuestionDocuments.map(document => ({
          documentId: document.documentId,
          currentPage: document.documentId === props.documentId ? currentPage : document.currentPage,
        })),
        documentQuestionOcrAllowed ? documentQuestionOcrPreferences : undefined,
      )
      setDocumentQuestionOpen(false)
      setDocumentQuestionDraft('')
      setDocumentQuestionOcrAllowed(false)
    })().catch((cause: unknown) => {
      setSelectionError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      setDocumentQuestionBusy(false)
    })
  }
  const documentQuestionButton = (
    <PdfToolbarButton
      iconOnly
      active={documentQuestionOpen}
      data-pdf-document-ai="true"
      aria-label="询问 PDF"
      aria-haspopup="dialog"
      aria-expanded={documentQuestionOpen}
      title={documentQuestionTitle}
      disabled={documentQuestionBusy}
      onClick={() => {
        setSelectionError(undefined)
        setSaveMenuOpen(false)
        setRotationMenuOpen(false)
        setFitMenuOpen(false)
        setEvidenceDrawerOpen(false)
        setDocumentQuestionOpen(open => {
          if (!open) setDocumentQuestionSelectedIds(new Set([props.documentId]))
          return !open
        })
      }}
    >
      <PdfAiSparkleIcon />
    </PdfToolbarButton>
  )
  const closeDocumentButton = (
    <PdfToolbarButton
      iconOnly
      data-pdf-close-document="true"
      aria-label="关闭当前 PDF"
      title="关闭当前 PDF"
      disabled={props.replaceBusy || props.saveBusy !== undefined}
      onClick={props.onCloseDocument}
    >
      <ClosePdfIcon />
    </PdfToolbarButton>
  )
  const documentIdentity = (
    <div
      ref={documentTabsRef}
      data-pdf-document-tabs="true"
      role="tablist"
      aria-label="已打开的 PDF"
      style={styles.documentTabs}
      onWheel={(event) => {
        const tabs = event.currentTarget
        if (tabs.scrollWidth <= tabs.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
        event.preventDefault()
        tabs.scrollLeft += event.deltaY
      }}
    >
      {props.documents.map(document => {
        const active = document.documentId === props.activeDocumentId
        return (
          <div
            key={document.documentId}
            role="tab"
            tabIndex={active ? 0 : -1}
            aria-selected={active}
            data-pdf-document-tab={document.documentId}
            style={{ ...styles.documentTab, ...(active ? styles.documentTabActive : {}) }}
            title={document.name}
            onClick={() => { props.onDocumentActivate(document.documentId) }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              props.onDocumentActivate(document.documentId)
            }}
          >
            <span style={styles.toolbarDocumentIcon}><PdfDocumentIcon /></span>
            <span data-pdf-document-name={active ? 'true' : undefined} style={styles.documentTabName}>{document.name}</span>
            {document.editorDirty && (
              <span
                data-pdf-unsaved-editor="true"
                data-pdf-unsaved-annotations="true"
                style={styles.documentTabDirty}
                title="批注或书签尚未写入 PDF"
              />
            )}
            <button
              type="button"
              aria-label={`关闭 ${document.name}`}
              title={`关闭 ${document.name}`}
              style={styles.documentTabClose}
              onClick={(event) => {
                event.stopPropagation()
                props.onDocumentClose(document.documentId)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
  const collapseButton = (
    <PdfToolbarButton
      iconOnly
      aria-label="收起 PDF 阅读器"
      title="收起 PDF 阅读器"
      onClick={() => { toggleWide(false) }}
    >
      <CollapsePdfPanelIcon />
    </PdfToolbarButton>
  )

  if (failed !== undefined || doc === undefined) {
    return createPortal(
      <div ref={widePanelRef} style={{
        ...styles.widePanel,
        visibility: wide ? 'visible' : 'hidden',
        pointerEvents: wide ? 'auto' : 'none',
        left: `${String(geometry.left)}px`,
        width: `${String(panelW)}px`,
      }}>
        <div data-pdf-document-toolbar="true" style={styles.toolbar}>
          {documentIdentity}
          <div style={styles.toolbarActions}>
            {replaceButton}
            {collapseButton}
            {closeDocumentButton}
          </div>
        </div>
        {failed !== undefined
          ? <div style={{ color: '#d4380d', padding: '12px' }}>PDF 解析失败：{failed}</div>
          : <div style={{ padding: '12px', color: 'var(--dsw-alias-content-tertiary, #999)' }}>解析中…</div>}
        {props.replaceError !== undefined && (
          <div role="alert" style={{ color: '#d4380d', padding: '0 12px', fontSize: '12px' }}>
            {props.replaceError}
          </div>
        )}
        {props.persistenceError !== undefined && (
          <div role="alert" data-pdf-session-error="true" style={{ color: '#ad6800', padding: '0 12px', fontSize: '12px' }}>
            {props.persistenceError}
          </div>
        )}
      </div>,
      document.body,
    )
  }

  // Runtime zoom changes only the outer overflow box plus the inner
  // compositor transform; renderScale trails it to sharpen five canvases.
  const renderScale = fitScale * renderZoom

  const activeAnnotation = annotationMenu?.kind === 'annotation'
    ? props.annotations.find(annotation => annotation.groupId === annotationMenu.groupId)
    : undefined
  const annotationMenuColor = activeAnnotation?.color ?? preferredHighlightColor
  const annotationMenuColorOption = pdfMarkupColorOption(annotationMenuColor)
  const annotationMenuStrokeWidth = activeAnnotation?.strokeWidth ?? preferredMarkupStrokeWidth
  const mixedAiActive = mixedTextIntent && selectedEvidenceImages.length > 0
  const mixedTextCount = (() => {
    if (annotationMenu?.kind !== 'selection') return selectedTextEvidence.length
    try {
      return pdfTextEvidenceSources(selectedTextEvidence, {
        ...annotationMenu.pending,
        documentId: props.documentId,
        documentName: props.documentName,
      }).length
    } catch {
      // Keep the menu usable so the explicit action can report the bounded
      // validation error instead of breaking the complete reader render.
      return selectedTextEvidence.length + 1
    }
  })()
  const annotationAiPopoverUpward = annotationMenuPlacement.top + 270 > window.innerHeight
  const annotationAiPopoverPlacement = annotationAiPopoverUpward
    ? { top: 'auto', bottom: 'calc(100% + 6px)' }
    : undefined
  const showInteractionNotice = (message: string): void => {
    if (interactionNoticeTimerRef.current !== undefined) {
      window.clearTimeout(interactionNoticeTimerRef.current)
    }
    setInteractionNotice(message)
    interactionNoticeTimerRef.current = window.setTimeout(() => {
      interactionNoticeTimerRef.current = undefined
      setInteractionNotice(undefined)
    }, 3000)
  }
  const addPendingTextEvidence = (pending: PendingPdfTextSelection): void => {
    setSelectionError(undefined)
    try {
      const id = `evidence-text-${createPdfDocumentId()}`
      const result = addPdfTextEvidence(textEvidence, {
        id,
        documentId: props.documentId,
        documentName: props.documentName,
        text: pending.text,
        drafts: pending.drafts,
      })
      props.onTextEvidenceChange(result.sources)
      if (result.added) {
        props.onEvidenceSelectionChange(selectedEvidenceImages, new Set([...selectedTextEvidenceIds, id]))
      }
      showInteractionNotice(result.added ? '已加入图文资料，可继续选择文字' : '这段文字已经在图文资料中')
      window.getSelection()?.removeAllRanges()
      setAnnotationMenu(undefined)
    } catch (cause) {
      setSelectionError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const submitTextAiRequest = (
    action: PdfAiAction,
    pending: PendingPdfTextSelection,
    question?: string,
  ): void => {
    if (annotationAiBusy !== undefined) return
    setSelectionError(undefined)
    setAnnotationAiBusy(action)
    void props.onTextAiRequest(
      action,
      pending.text,
      pending.drafts.map(draft => draft.pageNumber),
      question,
    ).then(() => {
      window.getSelection()?.removeAllRanges()
      setAnnotationMenu(undefined)
    }).catch((cause: unknown) => {
      setSelectionError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      setAnnotationAiBusy(undefined)
    })
  }
  const submitMixedAiRequest = (
    action: PdfMixedAiAction,
    pending: PendingPdfTextSelection,
    question?: string,
  ): void => {
    if (mixedAiBusy !== undefined || annotationAiBusy !== undefined) return
    const storedBatch = [...selectedTextEvidence]
    setSelectionError(undefined)
    let sources: readonly PdfTextEvidence[]
    try {
      sources = pdfTextEvidenceSources(storedBatch, {
        ...pending,
        documentId: props.documentId,
        documentName: props.documentName,
      })
    } catch (cause) {
      setSelectionError(cause instanceof Error ? cause.message : String(cause))
      return
    }
    setMixedAiBusy(action)
    void props.onMixedAiRequest(
      action,
      selectedEvidenceImages,
      sources,
      question,
    ).then(() => {
      window.getSelection()?.removeAllRanges()
      setMixedTextIntent(false)
      setAnnotationMenu(undefined)
    }).catch((cause: unknown) => {
      setSelectionError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      setMixedAiBusy(undefined)
    })
  }
  const submitEvidenceAiRequest = async (
    action: PdfMixedAiAction,
    images: readonly PdfEvidenceImage[],
    batch: readonly PdfTextEvidence[],
    question?: string,
  ): Promise<void> => {
    await props.onMixedAiRequest(
      action,
      images,
      batch,
      question,
    )
  }
  const annotationMenuSurface = annotationMenu !== undefined && annotationMenuAnchor !== undefined
    ? createPortal(
      <div
        ref={annotationMenuRef}
        data-pdf-annotation-menu="true"
        data-pdf-annotation-menu-kind={annotationMenu.kind}
        role="toolbar"
        aria-label={annotationMenu.kind === 'selection' ? '创建文字标记' : '编辑文字标记'}
        style={{
          ...styles.annotationMenu,
          left: annotationMenuPlacement.left,
          top: annotationMenuPlacement.top,
        }}
        onPointerDown={(event) => {
          const target = event.target
          if (!(target instanceof Element) || target.closest('[data-pdf-annotation-note-editor="true"], [data-pdf-ai-question-editor="true"]') === null) {
            event.preventDefault()
          }
          event.stopPropagation()
        }}
      >
        <span data-pdf-highlight-action="true" style={styles.annotationHighlightAction}>
          <button
            type="button"
            data-pdf-annotation-action="true"
            data-pdf-highlight-apply={annotationMenu.kind === 'selection' ? 'true' : undefined}
            aria-label={annotationMenu.kind === 'selection'
              ? `使用${annotationMenuColorOption.label}高亮`
              : '更改标记颜色'}
            title={annotationMenu.kind === 'selection'
              ? `使用${annotationMenuColorOption.label}高亮`
              : '更改标记颜色'}
            style={styles.annotationHighlightButton}
            onClick={() => {
              if (annotationMenu.kind === 'selection') {
                props.onTextMarkupAdd(annotationMenu.pending.drafts, 'highlight', annotationMenuColor, preferredMarkupStrokeWidth)
                window.getSelection()?.removeAllRanges()
                setAnnotationMenu(undefined)
              } else {
                setAnnotationStrokeMenuOpen(false)
                setAnnotationNoteGroupId(undefined)
                setAnnotationPaletteOpen(open => !open)
              }
            }}
          >
            <TextMarkupPdfIcon kind={activeAnnotation?.kind ?? 'highlight'} />
            <span aria-hidden="true" style={{ ...styles.annotationHighlightIndicator, background: annotationMenuColorOption.hex }} />
          </button>
          <button
            type="button"
            data-pdf-annotation-action="true"
            data-pdf-highlight-palette-toggle="true"
            aria-label={annotationMenu.kind === 'selection' ? '选择高亮颜色' : '选择标记颜色'}
            aria-expanded={annotationPaletteOpen}
            title={annotationMenu.kind === 'selection' ? '选择高亮颜色' : '选择标记颜色'}
            style={styles.annotationPaletteButton}
            onClick={() => {
              setAnnotationStrokeMenuOpen(false)
              setAnnotationNoteGroupId(undefined)
              setAnnotationPaletteOpen(open => !open)
            }}
          >
            <ChevronDownPdfIcon />
          </button>
          {annotationPaletteOpen && (
            <span data-pdf-highlight-palette="true" role="group" aria-label="高亮颜色" style={styles.annotationPalette}>
              {PDF_MARKUP_COLORS.map((option) => {
                const selected = annotationMenuColor === option.id
                const label = annotationMenu.kind === 'selection'
                  ? `使用${option.label}高亮`
                  : `将标记改为${option.label}`
                return (
                  <button
                    key={option.id}
                    type="button"
                    data-pdf-annotation-action="true"
                    data-pdf-highlight-color={option.id}
                    aria-label={label}
                    aria-pressed={selected}
                    title={label}
                    style={{
                      ...styles.annotationColorButton,
                      borderColor: selected ? '#4d6bfe' : 'transparent',
                      background: selected ? 'rgba(77,107,254,0.08)' : 'transparent',
                    }}
                    onClick={() => {
                      setPreferredHighlightColor(option.id)
                      if (annotationMenu.kind === 'selection') {
                        props.onTextMarkupAdd(annotationMenu.pending.drafts, 'highlight', option.id, preferredMarkupStrokeWidth)
                        window.getSelection()?.removeAllRanges()
                        setAnnotationMenu(undefined)
                      } else {
                        props.onTextMarkupColorChange(annotationMenu.groupId, option.id)
                        setAnnotationPaletteOpen(false)
                      }
                    }}
                  >
                    <span aria-hidden="true" style={{ ...styles.annotationColorSwatch, background: option.hex }} />
                  </button>
                )
              })}
            </span>
          )}
        </span>
        {annotationMenu.kind === 'selection' && (
          <>
            <button
              type="button"
              data-pdf-annotation-action="true"
              data-pdf-markup-apply="underline"
              aria-label={`使用${annotationMenuColorOption.label}下划线`}
              title={`使用${annotationMenuColorOption.label}下划线`}
              style={styles.annotationNoteButton}
              onClick={() => {
                props.onTextMarkupAdd(annotationMenu.pending.drafts, 'underline', annotationMenuColor, preferredMarkupStrokeWidth)
                window.getSelection()?.removeAllRanges()
                setAnnotationMenu(undefined)
              }}
            >
              <UnderlinePdfIcon />
            </button>
            <button
              type="button"
              data-pdf-annotation-action="true"
              data-pdf-markup-apply="strikeout"
              aria-label={`使用${annotationMenuColorOption.label}删除线`}
              title={`使用${annotationMenuColorOption.label}删除线`}
              style={styles.annotationNoteButton}
              onClick={() => {
                props.onTextMarkupAdd(annotationMenu.pending.drafts, 'strikeout', annotationMenuColor, preferredMarkupStrokeWidth)
                window.getSelection()?.removeAllRanges()
                setAnnotationMenu(undefined)
              }}
            >
              <StrikeoutPdfIcon />
            </button>
          </>
        )}
        {annotationMenu.kind === 'annotation' && activeAnnotation !== undefined && activeAnnotation.kind !== 'highlight' && (
          <span style={styles.annotationStrokeAction}>
            <button
              type="button"
              data-pdf-annotation-action="true"
              data-pdf-markup-stroke-toggle="true"
              aria-label="调整线宽"
              aria-expanded={annotationStrokeMenuOpen}
              title="调整线宽"
              style={{
                ...styles.annotationNoteButton,
                background: annotationStrokeMenuOpen ? 'rgba(77,107,254,0.1)' : 'transparent',
                color: annotationStrokeMenuOpen ? '#3154d8' : '#71717a',
              }}
              onClick={() => {
                setAnnotationPaletteOpen(false)
                setAnnotationNoteGroupId(undefined)
                setAnnotationStrokeMenuOpen(open => !open)
              }}
            >
              <LineWidthPdfIcon />
            </button>
            {annotationStrokeMenuOpen && (
              <span role="group" aria-label="标记线宽" style={styles.annotationStrokePalette}>
                {PDF_MARKUP_STROKE_WIDTHS.map(option => {
                  const selected = annotationMenuStrokeWidth === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      data-pdf-annotation-action="true"
                      data-pdf-markup-stroke-width={option.value}
                      aria-label={option.label}
                      aria-pressed={selected}
                      title={option.label}
                      style={{
                        ...styles.annotationStrokeOption,
                        borderColor: selected ? '#4d6bfe' : 'transparent',
                        background: selected ? 'rgba(77,107,254,0.08)' : 'transparent',
                      }}
                      onClick={() => {
                        setPreferredMarkupStrokeWidth(option.value)
                        props.onTextMarkupStrokeWidthChange(annotationMenu.groupId, option.value)
                        setAnnotationStrokeMenuOpen(false)
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          ...styles.annotationStrokeSample,
                          borderTop: `${String(option.value)}px solid currentColor`,
                        }}
                      />
                    </button>
                  )
                })}
              </span>
            )}
          </span>
        )}
        <button
          type="button"
          data-pdf-annotation-action="true"
          data-pdf-highlight-note="true"
          aria-label={activeAnnotation?.note.length ? '编辑批注' : '添加批注'}
          aria-pressed={annotationNoteGroupId !== undefined}
          title={activeAnnotation?.note.length ? '编辑批注' : '添加批注'}
          style={{
            ...styles.annotationNoteButton,
            background: annotationNoteGroupId !== undefined ? 'rgba(77,107,254,0.1)' : 'transparent',
            color: annotationNoteGroupId !== undefined ? '#3154d8' : '#71717a',
          }}
          onClick={() => {
            setAnnotationPaletteOpen(false)
            setAnnotationStrokeMenuOpen(false)
            if (annotationMenu.kind === 'selection') {
              const groupId = props.onTextMarkupAdd(annotationMenu.pending.drafts, 'highlight', annotationMenuColor, preferredMarkupStrokeWidth)
              if (groupId === undefined) return
              const anchor = annotationMenu.pending.anchor
              window.getSelection()?.removeAllRanges()
              setAnnotationMenu({ kind: 'annotation', groupId, anchor })
              setAnnotationNoteDraft('')
              setAnnotationNoteGroupId(groupId)
            } else {
              setAnnotationNoteDraft(activeAnnotation?.note ?? '')
              setAnnotationNoteGroupId(current => current === annotationMenu.groupId ? undefined : annotationMenu.groupId)
            }
          }}
        >
          <CommentPdfIcon />
          {activeAnnotation?.note.length ? <span aria-hidden="true" style={styles.annotationNoteIndicator} /> : null}
        </button>
        {annotationMenu.kind === 'selection' && (
          <>
            <span aria-hidden="true" style={styles.annotationMenuDivider} />
            <button
              type="button"
              data-pdf-annotation-action="true"
              data-pdf-copy-selection="true"
              aria-label={annotationCopyStatus === 'copied' ? '已复制' : annotationCopyStatus === 'failed' ? '复制失败' : '复制文字'}
              title={annotationCopyStatus === 'copied' ? '已复制' : annotationCopyStatus === 'failed' ? '复制失败' : '复制文字'}
              style={{
                ...styles.annotationNoteButton,
                color: annotationCopyStatus === 'copied'
                  ? '#16803a'
                  : annotationCopyStatus === 'failed' ? '#d4380d' : '#71717a',
              }}
              onClick={() => {
                setAnnotationPaletteOpen(false)
                const text = annotationMenu.pending.text
                void copyPdfTextSelection(text).then((copied) => {
                  if (annotationCopyTimerRef.current !== undefined) {
                    window.clearTimeout(annotationCopyTimerRef.current)
                  }
                  setAnnotationCopyStatus(copied ? 'copied' : 'failed')
                  annotationCopyTimerRef.current = window.setTimeout(() => {
                    annotationCopyTimerRef.current = undefined
                    setAnnotationCopyStatus(undefined)
                  }, 1600)
                })
              }}
            >
              {annotationCopyStatus === 'copied' ? <CheckPdfIcon /> : <CopyPdfIcon />}
            </button>
            <span style={styles.annotationAiAction}>
              <button
                type="button"
                data-pdf-annotation-action="true"
                data-pdf-ai-menu-toggle="true"
                aria-label="AI 阅读工具"
                aria-expanded={annotationAiMenuOpen || annotationAiQuestionOpen}
                title="解释、翻译或深入提问"
                style={{
                  ...styles.annotationAiButton,
                  background: annotationAiMenuOpen || annotationAiQuestionOpen
                    ? 'rgba(77,107,254,0.18)'
                    : styles.annotationAiButton.background,
                }}
                onClick={() => {
                  setAnnotationPaletteOpen(false)
                  setAnnotationStrokeMenuOpen(false)
                  setAnnotationNoteGroupId(undefined)
                  setSelectionError(undefined)
                  if (annotationAiQuestionOpen) {
                    setAnnotationAiQuestionOpen(false)
                    setAnnotationAiMenuOpen(false)
                  } else {
                    setAnnotationAiMenuOpen(open => !open)
                  }
                }}
              >
                <PdfAiSparkleIcon />
                <span>{mixedAiActive ? 'AI · 图文' : 'AI'}</span>
                <ChevronDownPdfIcon />
              </button>
              {annotationAiMenuOpen && (
                <div
                  data-pdf-ai-menu="true"
                  role="menu"
                  aria-label="AI 阅读操作"
                  style={{ ...styles.annotationAiMenu, ...annotationAiPopoverPlacement }}
                >
                  {mixedAiActive ? (
                    <>
                      <div data-pdf-mixed-ai-summary="true" style={styles.imageAiHeader}>
                        图文组合 · {String(selectedEvidenceImages.length)} 张图片 + {String(mixedTextCount)} 段文字
                      </div>
                      <button
                        type="button"
                        role="menuitem"
                        data-pdf-mixed-ai-action="explain"
                        disabled={mixedAiBusy !== undefined || annotationAiBusy !== undefined}
                        style={styles.annotationAiMenuItem}
                        onClick={() => { submitMixedAiRequest('explain', annotationMenu.pending) }}
                      >
                        <span style={styles.annotationAiMenuLabel}>综合解释</span>
                        <span style={styles.annotationAiMenuHint}>结合图中结构和文字论述说明概念</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-pdf-mixed-ai-action="relate"
                        disabled={mixedAiBusy !== undefined || annotationAiBusy !== undefined}
                        style={styles.annotationAiMenuItem}
                        onClick={() => { submitMixedAiRequest('relate', annotationMenu.pending) }}
                      >
                        <span style={styles.annotationAiMenuLabel}>分析对应关系</span>
                        <span style={styles.annotationAiMenuHint}>逐项对应文字陈述与图片中的部分</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-pdf-mixed-ai-action="verify"
                        disabled={mixedAiBusy !== undefined || annotationAiBusy !== undefined}
                        style={styles.annotationAiMenuItem}
                        onClick={() => { submitMixedAiRequest('verify', annotationMenu.pending) }}
                      >
                        <span style={styles.annotationAiMenuLabel}>核对一致性</span>
                        <span style={styles.annotationAiMenuHint}>检查支持、矛盾、遗漏和易误解之处</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-pdf-mixed-ai-action="question"
                        disabled={mixedAiBusy !== undefined || annotationAiBusy !== undefined}
                        style={styles.annotationAiMenuItem}
                        onClick={() => {
                          setAnnotationAiMenuOpen(false)
                          setAnnotationAiQuestionOpen(true)
                        }}
                      >
                        <span style={styles.annotationAiMenuLabel}>深入提问…</span>
                        <span style={styles.annotationAiMenuHint}>围绕当前已选资料图片和这段文字提问</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-pdf-mixed-ai-add-evidence="true"
                        disabled={mixedAiBusy !== undefined || annotationAiBusy !== undefined}
                        style={{ ...styles.annotationAiMenuItem, borderTop: '1px solid rgba(0,0,0,0.08)', marginTop: '3px' }}
                        onClick={() => { addPendingTextEvidence(annotationMenu.pending) }}
                      >
                        <span style={{ ...styles.annotationAiMenuLabel, color: '#3154d8' }}>加入资料，继续选择</span>
                        <span style={styles.annotationAiMenuHint}>暂存这段原文，稍后与更多图文一起分析</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-pdf-mixed-ai-text-only="true"
                        style={{ ...styles.annotationAiMenuItem, borderTop: '1px solid rgba(0,0,0,0.08)', marginTop: '3px' }}
                        onClick={() => { setMixedTextIntent(false) }}
                      >
                        <span style={styles.annotationAiMenuHint}>仅使用当前文字</span>
                      </button>
                    </>
                  ) : (
                    <>
                      {selectedEvidenceImages.length > 0 && (
                        <button
                          type="button"
                          role="menuitem"
                          data-pdf-ai-action="mixed"
                          disabled={mixedAiBusy !== undefined || annotationAiBusy !== undefined}
                          style={{ ...styles.annotationAiMenuItem, background: 'rgba(77,107,254,0.08)' }}
                          onClick={() => { setMixedTextIntent(true) }}
                        >
                          <span style={{ ...styles.annotationAiMenuLabel, color: '#3154d8' }}>
                            与 {String(selectedEvidenceImages.length)} 张已选资料图片一起分析
                          </span>
                          <span style={styles.annotationAiMenuHint}>将图片和当前选段作为同一次 AI 请求</span>
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        data-pdf-ai-action="evidence"
                        disabled={annotationAiBusy !== undefined || mixedAiBusy !== undefined}
                        style={styles.annotationAiMenuItem}
                        onClick={() => { addPendingTextEvidence(annotationMenu.pending) }}
                      >
                        <span style={styles.annotationAiMenuLabel}>加入图文资料</span>
                        <span style={styles.annotationAiMenuHint}>收集多段原文，之后统一定位和分析</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-pdf-ai-action="explain"
                        disabled={annotationAiBusy !== undefined || mixedAiBusy !== undefined}
                        style={styles.annotationAiMenuItem}
                        onClick={() => { submitTextAiRequest('explain', annotationMenu.pending) }}
                      >
                        <span style={styles.annotationAiMenuLabel}>解释选段</span>
                        <span style={styles.annotationAiMenuHint}>结合当前对话与工作区说明概念</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-pdf-ai-action="translate"
                        disabled={annotationAiBusy !== undefined || mixedAiBusy !== undefined}
                        style={styles.annotationAiMenuItem}
                        onClick={() => { submitTextAiRequest('translate', annotationMenu.pending) }}
                      >
                        <span style={styles.annotationAiMenuLabel}>翻译选段</span>
                        <span style={styles.annotationAiMenuHint}>保留术语、公式和代码格式</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-pdf-ai-action="question"
                        disabled={annotationAiBusy !== undefined || mixedAiBusy !== undefined}
                        style={styles.annotationAiMenuItem}
                        onClick={() => {
                          setAnnotationAiMenuOpen(false)
                          setAnnotationAiQuestionOpen(true)
                        }}
                      >
                        <span style={styles.annotationAiMenuLabel}>深入提问…</span>
                        <span style={styles.annotationAiMenuHint}>围绕原文提出自己的问题</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-pdf-ai-action="context"
                        disabled={annotationAiBusy !== undefined || mixedAiBusy !== undefined}
                        style={styles.annotationAiMenuItem}
                        onClick={() => {
                          setSelectionError(undefined)
                          const pending = annotationMenu.pending
                          try {
                            props.onTextReferenceAdd(
                              pending.text,
                              pending.drafts.map(draft => draft.pageNumber),
                            )
                            window.getSelection()?.removeAllRanges()
                            setAnnotationMenu(undefined)
                          } catch (cause) {
                            setSelectionError(cause instanceof Error ? cause.message : String(cause))
                          }
                        }}
                      >
                        <span style={styles.annotationAiMenuLabel}>加入上下文</span>
                        <span style={styles.annotationAiMenuHint}>暂存到主输入框，与其他片段组合</span>
                      </button>
                    </>
                  )}
                </div>
              )}
              {annotationAiQuestionOpen && (
                <form
                  data-pdf-ai-question-editor="true"
                  aria-label={mixedAiActive ? '围绕 PDF 图文资料深入提问' : '围绕 PDF 选段深入提问'}
                  style={{ ...styles.annotationAiQuestionEditor, ...annotationAiPopoverPlacement }}
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (mixedAiActive) submitMixedAiRequest('question', annotationMenu.pending, annotationAiQuestionDraft)
                    else submitTextAiRequest('question', annotationMenu.pending, annotationAiQuestionDraft)
                  }}
                >
                  <div style={styles.annotationAiQuestionTitle}>
                    {mixedAiActive
                      ? `${String(selectedEvidenceImages.length)} 张图片 + ${String(mixedTextCount)} 段文字`
                      : '围绕这段原文提问'}
                  </div>
                  <textarea
                    ref={annotationAiQuestionInputRef}
                    aria-label={mixedAiActive ? '图文提问内容' : '深入提问内容'}
                    placeholder={mixedAiActive ? '例如：正文中的描述分别对应图中哪些部分？' : '例如：这段结论如何对应当前项目？'}
                    maxLength={MAX_PDF_AI_QUESTION_CODE_UNITS}
                    value={annotationAiQuestionDraft}
                    style={styles.annotationNoteTextarea}
                    onChange={(event) => { setAnnotationAiQuestionDraft(event.target.value) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        event.stopPropagation()
                        setAnnotationAiQuestionOpen(false)
                        setAnnotationAiMenuOpen(true)
                      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault()
                        if (mixedAiActive) submitMixedAiRequest('question', annotationMenu.pending, annotationAiQuestionDraft)
                        else submitTextAiRequest('question', annotationMenu.pending, annotationAiQuestionDraft)
                      }
                    }}
                  />
                  <div style={styles.annotationNoteFooter}>
                    <span style={styles.annotationNoteCount}>
                      {String(annotationAiQuestionDraft.length)} / {String(MAX_PDF_AI_QUESTION_CODE_UNITS)}
                    </span>
                    <span style={styles.annotationNoteActions}>
                      <button
                        type="button"
                        style={styles.annotationNoteAction}
                        onClick={() => {
                          setAnnotationAiQuestionOpen(false)
                          setAnnotationAiMenuOpen(true)
                        }}
                      >
                        返回
                      </button>
                      <button
                        type="submit"
                        data-pdf-ai-question-send="true"
                        disabled={annotationAiBusy !== undefined || mixedAiBusy !== undefined || annotationAiQuestionDraft.trim().length === 0}
                        style={{ ...styles.annotationNoteAction, ...styles.annotationNoteSave }}
                      >
                        {annotationAiBusy === 'question' || mixedAiBusy === 'question' ? '发送中…' : '发送'}
                      </button>
                    </span>
                  </div>
                </form>
              )}
            </span>
          </>
        )}
        {annotationMenu.kind === 'annotation' && (
          <>
            <span aria-hidden="true" style={styles.annotationMenuDivider} />
            <button
              type="button"
              data-pdf-highlight-delete="true"
              data-pdf-annotation-action="true"
              aria-label="删除标记"
              title="删除标记"
              style={styles.annotationDeleteButton}
              onClick={() => {
                props.onTextMarkupRemove(annotationMenu.groupId)
                setAnnotationMenu(undefined)
              }}
            >
              <DeletePdfIcon />
            </button>
          </>
        )}
        {annotationMenu.kind === 'annotation' && annotationNoteGroupId === annotationMenu.groupId && (
          <div
            data-pdf-annotation-note-editor="true"
            role="dialog"
            aria-label="文字标记批注"
            style={styles.annotationNoteEditor}
          >
            <textarea
              ref={annotationNoteInputRef}
              data-pdf-annotation-note-input="true"
              aria-label="批注内容"
              placeholder="添加批注…"
              maxLength={MAX_PDF_ANNOTATION_NOTE_LENGTH}
              value={annotationNoteDraft}
              style={styles.annotationNoteTextarea}
              onChange={(event) => { setAnnotationNoteDraft(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  setAnnotationNoteGroupId(undefined)
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  props.onTextMarkupNoteChange(annotationMenu.groupId, annotationNoteDraft)
                  setAnnotationNoteGroupId(undefined)
                }
              }}
            />
            <div style={styles.annotationNoteFooter}>
              <span style={styles.annotationNoteCount}>
                {String(annotationNoteDraft.length)} / {String(MAX_PDF_ANNOTATION_NOTE_LENGTH)}
              </span>
              <span style={styles.annotationNoteActions}>
                <button
                  type="button"
                  style={styles.annotationNoteAction}
                  onClick={() => { setAnnotationNoteGroupId(undefined) }}
                >
                  取消
                </button>
                <button
                  type="button"
                  data-pdf-annotation-note-save="true"
                  style={{ ...styles.annotationNoteAction, ...styles.annotationNoteSave }}
                  onClick={() => {
                    props.onTextMarkupNoteChange(annotationMenu.groupId, annotationNoteDraft)
                    setAnnotationNoteGroupId(undefined)
                  }}
                >
                  保存
                </button>
              </span>
            </div>
          </div>
        )}
      </div>,
      document.body,
    )
    : undefined

  const submitImageAiRequest = (
    action: PdfImageAiAction,
    question?: string,
  ): void => {
    if (imageAiBusy !== undefined) return
    setSelectionError(undefined)
    setImageAiBusy(action)
    void props.onImageAiRequest(action, question).then(() => {
      setImageAiMenu(undefined)
      setImageAiQuestionOpen(false)
      setImageAiQuestionDraft('')
    }).catch((cause: unknown) => {
      setSelectionError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      setImageAiBusy(undefined)
    })
  }

  const imageAiMenuSurface = imageAiMenu === undefined
    ? undefined
    : createPortal(
      <div
        ref={imageAiMenuRef}
        data-pdf-image-ai-menu="true"
        role={imageAiQuestionOpen ? 'dialog' : 'menu'}
        aria-label={imageAiQuestionOpen ? '询问 PDF 图片选区' : 'PDF 图片 AI'}
        style={{
          ...styles.imageAiMenu,
          width: imageAiQuestionOpen ? '292px' : styles.imageAiMenu.width,
          left: imageAiMenuPlacement.left,
          top: imageAiMenuPlacement.top,
        }}
        onPointerDown={(event) => {
          if (!(event.target instanceof HTMLTextAreaElement)) event.preventDefault()
          event.stopPropagation()
        }}
      >
        <div style={styles.imageAiHeader}>
          <span>✨ 图片 AI · {String(Math.max(1, props.selections.length))} 个对话选区</span>
          <button
            type="button"
            data-pdf-image-ai-close="true"
            aria-label="关闭图片 AI 菜单"
            title="关闭"
            style={styles.imageAiClose}
            onClick={() => {
              setImageAiMenu(undefined)
              setImageAiQuestionOpen(false)
            }}
          >
            ×
          </button>
        </div>
        {!imageAiQuestionOpen ? (
          <>
            <button
              type="button"
              role="menuitem"
              data-pdf-image-ai-action="explain"
              disabled={imageAiBusy !== undefined}
              style={styles.annotationAiMenuItem}
              onClick={() => { submitImageAiRequest('explain') }}
            >
              <span style={styles.annotationAiMenuLabel}>解释图片</span>
              <span style={styles.annotationAiMenuHint}>综合理解所有选区及它们之间的关系</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-pdf-image-ai-action="ocr"
              disabled={imageAiBusy !== undefined}
              style={styles.annotationAiMenuItem}
              onClick={() => { submitImageAiRequest('ocr') }}
            >
              <span style={styles.annotationAiMenuLabel}>识别文字</span>
              <span style={styles.annotationAiMenuHint}>按编号转写全部选区，保留代码和表格结构</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-pdf-image-ai-action="translate"
              disabled={imageAiBusy !== undefined}
              style={styles.annotationAiMenuItem}
              onClick={() => { submitImageAiRequest('translate') }}
            >
              <span style={styles.annotationAiMenuLabel}>翻译图片文字</span>
              <span style={styles.annotationAiMenuHint}>依次识别全部选区，再保留术语与版式翻译</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-pdf-image-ai-action="question"
              disabled={imageAiBusy !== undefined}
              style={styles.annotationAiMenuItem}
              onClick={() => { setImageAiQuestionOpen(true) }}
            >
              <span style={styles.annotationAiMenuLabel}>深入提问…</span>
              <span style={styles.annotationAiMenuHint}>围绕当前全部选区提出自己的问题</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-pdf-image-ai-action="add-evidence"
              disabled={imageAiBusy !== undefined}
              style={{ ...styles.annotationAiMenuItem, borderTop: '1px solid rgba(0,0,0,0.08)', marginTop: '3px' }}
              onClick={() => {
                try {
                  props.onSelectionMoveToEvidence(imageAiMenu.selection)
                  setImageAiMenu(undefined)
                  setImageAiQuestionOpen(false)
                  showInteractionNotice('已移入图文资料，并从对话框附件中移除')
                } catch (cause) {
                  setSelectionError(cause instanceof Error ? cause.message : String(cause))
                }
              }}
            >
              <span style={{ ...styles.annotationAiMenuLabel, color: '#6b4fd8' }}>加入图文资料</span>
              <span style={styles.annotationAiMenuHint}>从对话框移出这张图片，作为 PDF 资料保存</span>
            </button>
          </>
        ) : (
          <form
            data-pdf-image-ai-question-editor="true"
            onSubmit={(event) => {
              event.preventDefault()
              submitImageAiRequest('question', imageAiQuestionDraft)
            }}
          >
            <div style={styles.annotationAiQuestionTitle}>你想了解这个图片区域的什么？</div>
            <textarea
              ref={imageAiQuestionInputRef}
              data-pdf-image-ai-question-input="true"
              aria-label="图片选区问题"
              placeholder="例如：请解释图中的数据趋势…"
              maxLength={MAX_PDF_IMAGE_AI_QUESTION_CODE_UNITS}
              value={imageAiQuestionDraft}
              style={styles.annotationNoteTextarea}
              onChange={(event) => { setImageAiQuestionDraft(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  setImageAiQuestionOpen(false)
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  submitImageAiRequest('question', imageAiQuestionDraft)
                }
              }}
            />
            <div style={styles.annotationNoteFooter}>
              <span style={styles.annotationNoteCount}>
                {String(imageAiQuestionDraft.length)} / {String(MAX_PDF_IMAGE_AI_QUESTION_CODE_UNITS)}
              </span>
              <span style={styles.annotationNoteActions}>
                <button
                  type="button"
                  style={styles.annotationNoteAction}
                  onClick={() => { setImageAiQuestionOpen(false) }}
                >
                  返回
                </button>
                <button
                  type="submit"
                  data-pdf-image-ai-question-send="true"
                  disabled={imageAiBusy !== undefined || imageAiQuestionDraft.trim().length === 0}
                  style={{ ...styles.annotationNoteAction, ...styles.annotationNoteSave }}
                >
                  {imageAiBusy === 'question' ? '发送中…' : '发送'}
                </button>
              </span>
            </div>
          </form>
        )}
      </div>,
      document.body,
    )

  const documentQuestionSurface = documentQuestionOpen
    ? (
      <div
        data-pdf-document-question-backdrop="true"
        style={styles.documentQuestionBackdrop}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget && !documentQuestionBusy) setDocumentQuestionOpen(false)
        }}
      >
        <form
          data-pdf-document-question-dialog="true"
          role="dialog"
          aria-modal="true"
          aria-label="询问 PDF"
          style={styles.documentQuestionDialog}
          onPointerDown={(event) => { event.stopPropagation() }}
          onSubmit={(event) => {
            event.preventDefault()
            submitDocumentQuestion()
          }}
        >
          <div style={styles.documentQuestionHeader}>
            <div style={{ minWidth: 0 }}>
              <div style={styles.documentQuestionTitle}>
                {selectedQuestionDocuments.length > 1 ? '询问多份 PDF' : '询问 PDF'}
              </div>
              <div style={styles.documentQuestionDocument}>
                已选择 {String(selectedQuestionDocuments.length)} / {String(props.documents.length)} 份
              </div>
            </div>
            <button
              type="button"
              aria-label="关闭询问 PDF"
              title="关闭"
              disabled={documentQuestionBusy}
              style={styles.imageAiClose}
              onClick={() => { setDocumentQuestionOpen(false) }}
            >
              ×
            </button>
          </div>
          <div
            data-pdf-document-question-scope="true"
            style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 10px', border: '1px solid #e4e8f2', borderRadius: '8px', background: '#fafbfc' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '11px', color: '#686d76' }}>
              <span>本次分析范围（发送后固定）</span>
              {props.documents.length > 1 && (
                <span style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    disabled={documentQuestionBusy}
                    style={{ padding: 0, border: 0, background: 'transparent', color: '#4d6bfe', cursor: 'pointer', fontSize: '11px' }}
                    onClick={() => { setDocumentQuestionSelectedIds(new Set([props.documentId])) }}
                  >仅当前</button>
                  <button
                    type="button"
                    disabled={documentQuestionBusy}
                    style={{ padding: 0, border: 0, background: 'transparent', color: '#4d6bfe', cursor: 'pointer', fontSize: '11px' }}
                    onClick={() => { setDocumentQuestionSelectedIds(new Set(props.documents.map(document => document.documentId))) }}
                  >全部</button>
                </span>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '132px', overflowY: 'auto' }}>
              {props.documents.map(document => (
                <label
                  key={document.documentId}
                  title={document.name}
                  style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0, padding: '4px 5px', borderRadius: '5px', cursor: documentQuestionBusy ? 'default' : 'pointer', background: documentQuestionSelectedIds.has(document.documentId) ? '#eef2ff' : 'transparent' }}
                >
                  <input
                    type="checkbox"
                    data-pdf-document-question-scope-item={document.documentId}
                    checked={documentQuestionSelectedIds.has(document.documentId)}
                    disabled={documentQuestionBusy}
                    onChange={(event) => {
                      setDocumentQuestionSelectedIds(current => {
                        const next = new Set(current)
                        if (event.target.checked) next.add(document.documentId)
                        else next.delete(document.documentId)
                        return next
                      })
                    }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#30343b', fontSize: '12px' }}>
                    {document.name}{document.documentId === props.documentId ? '（当前）' : ''}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <textarea
            ref={documentQuestionInputRef}
            data-pdf-document-question-input="true"
            aria-label="询问 PDF 的问题"
            placeholder="例如：本章如何解释共享内存与寄存器的性能差异？"
            maxLength={MAX_PDF_AI_QUESTION_CODE_UNITS}
            value={documentQuestionDraft}
            disabled={documentQuestionBusy}
            style={{ ...styles.annotationNoteTextarea, minHeight: '108px' }}
            onChange={(event) => { setDocumentQuestionDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !documentQuestionBusy) {
                event.preventDefault()
                event.stopPropagation()
                setDocumentQuestionOpen(false)
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                submitDocumentQuestion()
              }
            }}
          />
          <div
            data-pdf-document-ocr-permission="true"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '9px',
              padding: '9px 10px',
              border: '1px solid #e4e8f2',
              borderRadius: '8px',
              background: documentQuestionOcrAllowed ? '#f3f6ff' : '#fafafa',
              color: '#30343b',
              fontSize: '12px',
              lineHeight: 1.45,
            }}
          >
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: documentQuestionBusy ? 'default' : 'pointer' }}>
              <input
                type="checkbox"
                checked={documentQuestionOcrAllowed}
                disabled={documentQuestionBusy}
                style={{ margin: '2px 0 0', flex: '0 0 auto' }}
                onChange={(event) => { setDocumentQuestionOcrAllowed(event.target.checked) }}
              />
              <span>
                允许 AI 为本次问题按需 OCR，并在必要时查看原始页面图像。
                多份 PDF 共用下方一份总额度，由 AI 按相关性分配。
                默认关闭，发送后本项会自动复位。
              </span>
            </label>
            <div
              data-pdf-document-ocr-limits="true"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px' }}
            >
              <label style={{ display: 'flex', minWidth: 0, flexDirection: 'column', gap: '3px', color: '#60646c' }}>
                <span>OCR 新页面</span>
                <input
                  data-pdf-document-ocr-pages="true"
                  type="number"
                  min={1}
                  step={1}
                  value={documentQuestionOcrPreferences.maxOcrPages}
                  disabled={documentQuestionBusy || !documentQuestionOcrAllowed}
                  title="缓存页不计入；提高数值会增加本地识别时间和 CPU、内存占用"
                  style={{ width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '5px 6px', border: '1px solid #d8dce5', borderRadius: '6px', background: '#fff', color: '#262626' }}
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber
                    const normalized = Math.round(value)
                    if (!Number.isSafeInteger(normalized)) return
                    setDocumentQuestionOcrPreferences(current => ({
                      ...current,
                      maxOcrPages: Math.max(1, normalized),
                    }))
                  }}
                />
              </label>
              <label style={{ display: 'flex', minWidth: 0, flexDirection: 'column', gap: '3px', color: '#60646c' }}>
                <span>原页图像</span>
                <input
                  data-pdf-document-visual-pages="true"
                  type="number"
                  min={0}
                  step={1}
                  value={documentQuestionOcrPreferences.maxVisualPages}
                  disabled={documentQuestionBusy || !documentQuestionOcrAllowed}
                  title="每张原页图像都会占用视觉模型上下文和 token"
                  style={{ width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '5px 6px', border: '1px solid #d8dce5', borderRadius: '6px', background: '#fff', color: '#262626' }}
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber
                    const normalized = Math.round(value)
                    if (!Number.isSafeInteger(normalized)) return
                    setDocumentQuestionOcrPreferences(current => ({
                      ...current,
                      maxVisualPages: Math.max(0, normalized),
                    }))
                  }}
                />
              </label>
              <label style={{ display: 'flex', minWidth: 0, flexDirection: 'column', gap: '3px', color: '#60646c' }}>
                <span>单批页数</span>
                <input
                  data-pdf-document-ocr-batch="true"
                  type="number"
                  min={1}
                  step={1}
                  value={documentQuestionOcrPreferences.maxPagesPerBatch}
                  disabled={documentQuestionBusy || !documentQuestionOcrAllowed}
                  title="更大的单批会延长一次等待，并扩大一次失败所影响的页面范围"
                  style={{ width: '100%', minWidth: 0, boxSizing: 'border-box', padding: '5px 6px', border: '1px solid #d8dce5', borderRadius: '6px', background: '#fff', color: '#262626' }}
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber
                    const normalized = Math.round(value)
                    if (!Number.isSafeInteger(normalized)) return
                    setDocumentQuestionOcrPreferences(current => ({
                      ...current,
                      maxPagesPerBatch: Math.max(1, normalized),
                    }))
                  }}
                />
              </label>
            </div>
            <div
              data-pdf-document-ocr-cost-warning="true"
              aria-live="polite"
              style={{
                padding: '7px 8px',
                borderRadius: '6px',
                background: documentQuestionOcrAboveDefault ? '#fff7e6' : '#f3f4f6',
                color: documentQuestionOcrAboveDefault ? '#9a5800' : '#686d76',
                fontSize: '11px',
                lineHeight: 1.5,
              }}
            >
              不设固定上限。提高 OCR 页数会增加本地识别耗时与 CPU、内存占用；提高原页图像数会增加视觉 token；提高单批页数会延长单次等待，并扩大失败重试范围。
            </div>
          </div>
          <div style={styles.documentQuestionStatus}>
            {documentIndexStatus.kind === 'indexing'
              ? `原生文字索引进行中：${String(documentIndexStatus.indexedPages)}/${String(documentIndexStatus.totalPages)} 页；无需等待即可提问。`
              : documentIndexStatus.kind === 'error'
                ? documentIndexStatus.message
                : documentIndexStatus.truncated
                  ? '索引已达到文字上限；AI 会明确说明实际检索范围。'
                  : 'AI 会按需查目录、搜索原文并读取相关页面。'}
          </div>
          <div style={styles.annotationNoteFooter}>
            <span style={styles.annotationNoteCount}>
              {String(documentQuestionDraft.length)} / {String(MAX_PDF_AI_QUESTION_CODE_UNITS)} · Ctrl/⌘ + Enter 发送
            </span>
            <span style={styles.annotationNoteActions}>
              <button
                type="button"
                disabled={documentQuestionBusy}
                style={styles.annotationNoteAction}
                onClick={() => { setDocumentQuestionOpen(false) }}
              >
                取消
              </button>
              <button
                type="submit"
                data-pdf-document-question-send="true"
                disabled={documentQuestionBusy || documentQuestionDraft.trim().length === 0 || selectedQuestionDocuments.length === 0}
                style={{
                  ...styles.annotationNoteAction,
                  ...styles.annotationNoteSave,
                  ...((documentQuestionBusy || documentQuestionDraft.trim().length === 0 || selectedQuestionDocuments.length === 0)
                    ? { cursor: 'default', opacity: 0.48 }
                    : {}),
                }}
              >
                {documentQuestionBusy ? '发送中…' : '发送'}
              </button>
            </span>
          </div>
        </form>
      </div>
    )
    : undefined

  const body = (
    <>
      <style>{PDF_TEXT_LAYER_CSS}</style>
      {annotationMenuSurface}
      {imageAiMenuSurface}
      {documentQuestionSurface}
      <div data-pdf-document-toolbar="true" style={styles.toolbar}>
        {documentIdentity}
        <div style={styles.toolbarActions}>
          {replaceButton}
          {saveButton}
          {documentQuestionButton}
          <PdfToolbarButton
            iconOnly
            active={interactionMode === 'crop'}
            data-pdf-interaction-mode-button="true"
            data-pdf-interaction-mode={interactionMode}
            aria-pressed={interactionMode === 'crop'}
            aria-label={interactionMode === 'crop' ? '区域截图模式' : '文字选择模式'}
            title={interactionMode === 'crop'
              ? '当前：区域截图；点击或按 Esc 返回文字选择'
              : '当前：文字选择；点击切换到区域截图'}
            onClick={() => {
              const nextMode = interactionMode === 'text' ? 'crop' : 'text'
              if (nextMode === 'crop') window.getSelection()?.removeAllRanges()
              setAnnotationMenu(undefined)
              setImageAiMenu(undefined)
              setImageAiQuestionOpen(false)
              setInteractionNotice(undefined)
              setEvidenceDrawerOpen(false)
              setSaveMenuOpen(false)
              setFitMenuOpen(false)
              setRotationMenuOpen(false)
              setInteractionMode(nextMode)
            }}
          >
            {interactionMode === 'crop' ? <CropSelectPdfIcon /> : <TextSelectPdfIcon />}
          </PdfToolbarButton>
          <div ref={rotationMenuRef} style={styles.selectionMenuAnchor}>
            <PdfToolbarButton
              iconOnly
              data-pdf-rotation-menu-button="true"
              aria-haspopup="menu"
              aria-expanded={rotationMenuOpen}
              aria-label="旋转视图"
              title={`旋转视图（当前页 ${String(rotationForPage(currentPage))}°）`}
              onClick={() => {
                setSaveMenuOpen(false)
                setFitMenuOpen(false)
                setRotationMenuOpen(open => !open)
              }}
            >
              <RotatePdfIcon />
            </PdfToolbarButton>
            {rotationMenuOpen && (
              <div data-pdf-rotation-menu="true" role="menu" aria-label="PDF 旋转视图" style={styles.rotationMenu}>
                <button
                  data-pdf-rotate-current-left="true"
                  type="button"
                  role="menuitem"
                  style={styles.rotationMenuItem}
                  onClick={() => { rotateView('current', -90) }}
                >
                  当前页向左旋转
                </button>
                <button
                  data-pdf-rotate-current-right="true"
                  type="button"
                  role="menuitem"
                  style={styles.rotationMenuItem}
                  onClick={() => { rotateView('current', 90) }}
                >
                  当前页向右旋转
                </button>
                <button
                  data-pdf-reset-current-rotation="true"
                  type="button"
                  role="menuitem"
                  style={styles.rotationMenuItem}
                  onClick={resetCurrentRotation}
                >
                  重置当前页方向
                </button>
                <div aria-hidden="true" style={styles.rotationMenuDivider} />
                <button
                  data-pdf-rotate-all-left="true"
                  type="button"
                  role="menuitem"
                  style={styles.rotationMenuItem}
                  onClick={() => { rotateView('all', -90) }}
                >
                  全部页面向左旋转
                </button>
                <button
                  data-pdf-rotate-all-right="true"
                  type="button"
                  role="menuitem"
                  style={styles.rotationMenuItem}
                  onClick={() => { rotateView('all', 90) }}
                >
                  全部页面向右旋转
                </button>
                <button
                  data-pdf-reset-all-rotation="true"
                  type="button"
                  role="menuitem"
                  style={styles.rotationMenuItem}
                  onClick={resetAllRotations}
                >
                  重置全部页面方向
                </button>
              </div>
            )}
          </div>
          <PdfToolbarButton
            iconOnly
            data-pdf-thumbnails-button="true"
            aria-pressed={thumbnailsOpen}
            aria-label={thumbnailsOpen ? '关闭缩略图' : '打开缩略图'}
            title={thumbnailsOpen ? '关闭缩略图' : '打开缩略图'}
            onClick={() => {
              setEvidenceDrawerOpen(false)
              setSaveMenuOpen(false)
              setFitMenuOpen(false)
              setRotationMenuOpen(false)
              setAnnotationDrawerOpen(false)
              setThumbnailsOpen(open => !open)
            }}
          >
            <ThumbnailPdfIcon />
          </PdfToolbarButton>
          <PdfToolbarButton
            iconOnly
            active={annotationDrawerOpen}
            data-pdf-annotation-drawer-button="true"
            aria-pressed={annotationDrawerOpen}
            aria-label={annotationDrawerOpen ? '关闭批注中心' : '打开批注中心'}
            title="批注中心"
            onClick={() => {
              setEvidenceDrawerOpen(false)
              setSaveMenuOpen(false)
              setFitMenuOpen(false)
              setRotationMenuOpen(false)
              setThumbnailsOpen(false)
              setAnnotationMenu(undefined)
              setAnnotationAiMenuOpen(false)
              setAnnotationAiQuestionOpen(false)
              setAnnotationDrawerOpen(open => !open)
            }}
          >
            <AnnotationListPdfIcon />
          </PdfToolbarButton>
          {geometry.overlay && outlineController !== undefined && (
            <PdfToolbarButton onClick={() => {
              setAnnotationDrawerOpen(false)
              setNavigationDrawer('search')
            }}>搜索</PdfToolbarButton>
          )}
          {geometry.overlay && outlineController !== undefined && (
            <PdfToolbarButton onClick={() => {
              setAnnotationDrawerOpen(false)
              setNavigationDrawer('outline')
            }}>目录</PdfToolbarButton>
          )}
          {props.evidenceImages.length + textEvidence.length > 0 && (
            <PdfToolbarButton
              active={evidenceDrawerOpen}
              data-pdf-evidence-button="true"
              aria-expanded={evidenceDrawerOpen}
              aria-label={`图文资料：共 ${String(props.evidenceImages.length)} 张图片、${String(textEvidence.length)} 段文字；已选 ${String(selectedEvidenceImages.length)} 张图片、${String(selectedTextEvidence.length)} 段文字`}
              onClick={() => {
                setSaveMenuOpen(false)
                setFitMenuOpen(false)
                setRotationMenuOpen(false)
                setThumbnailsOpen(false)
                setAnnotationDrawerOpen(false)
                setEvidenceDrawerOpen(open => !open)
              }}
            >
              资料 · 已选 图 {String(selectedEvidenceImages.length)} · 文 {String(selectedTextEvidence.length)}
            </PdfToolbarButton>
          )}
          {collapseButton}
          {closeDocumentButton}
        </div>
      </div>
      {props.replaceError !== undefined && (
        <div role="alert" style={{ color: '#d4380d', paddingBottom: '6px', fontSize: '12px' }}>
          {props.replaceError}
        </div>
      )}
      {props.saveError !== undefined && (
        <div role="alert" data-pdf-save-error="true" style={{ color: '#d4380d', paddingBottom: '6px', fontSize: '12px' }}>
          {props.saveError}
        </div>
      )}
      {props.persistenceError !== undefined && (
        <div role="alert" data-pdf-session-error="true" style={{ color: '#ad6800', paddingBottom: '6px', fontSize: '12px' }}>
          {props.persistenceError}
        </div>
      )}
      <div
        data-pdf-viewport="true"
        style={styles.pdfViewport}
        onPointerMove={handleCornerControlPointerMove}
        onPointerLeave={() => {
          pointerZoomAnchorRef.current = undefined
          scheduleCornerControlHide('navigation')
          scheduleCornerControlHide('zoom')
        }}
      >
        <div
          ref={scrollerRef}
          data-pdf-scroll="true"
          data-pdf-fit-mode={fitMode}
          style={styles.scroller}
          tabIndex={-1}
          onPointerDown={(event) => {
            const target = event.target
            if (interactionMode === 'text' && target instanceof Element && target.closest('[data-pdf-text-layer="true"]') !== null) return
            event.currentTarget.focus({ preventScroll: true })
          }}
        >
          <div
            ref={zoomSizerRef}
            data-pdf-zoom-sizer="true"
            style={{
              ...styles.zoomSizer,
              width: `${String(pageStackLayout.width * zoom)}px`,
              height: `${String(pageStackLayout.height * zoom)}px`,
            }}
          >
            <div
              ref={contentRef}
              data-pdf-content="true"
              style={{
                ...styles.scrollerContent,
                width: `${String(pageStackLayout.width)}px`,
                height: `${String(pageStackLayout.height)}px`,
                transform: `scale(${String(zoom)})`,
              }}
            >
              <PdfPages
                doc={doc}
                currentPage={currentPage}
                layoutScale={fitScale}
                renderScale={renderScale}
                documentRotation={documentRotation}
                pageRotations={pageRotations}
                rotationRevision={rotationRevision}
                pageSizes={pageSizes}
                stackLayout={pageStackLayout}
                selections={props.selections}
                evidenceImages={props.evidenceImages.flatMap((image, index) => (
                  image.documentId === props.documentId ? [{ selection: image, order: index + 1 }] : []
                ))}
                annotations={props.annotations}
                bookmarks={props.bookmarks}
                zoom={zoom}
                evidenceText={activeEvidenceText}
                evidenceImage={activeEvidenceImage}
                evidenceHighlightRevision={evidenceHighlightRevision}
                imageLimits={props.imageLimits}
                onSelect={handleSelection}
                onSelectionRemove={props.onSelectionRemove}
                onSelectionActivate={(selection, anchor) => {
                  setSelectionError(undefined)
                  setAnnotationMenu(undefined)
                  setImageAiQuestionDraft('')
                  setImageAiQuestionOpen(false)
                  setImageAiMenu({ selection, anchor })
                }}
                onEvidenceImageRemove={(selection) => {
                  const evidence = props.evidenceImages.find(candidate => candidate === selection)
                  if (evidence !== undefined) props.onEvidenceImageRemove(evidence)
                }}
                onSelectionError={setSelectionError}
                interactionMode={interactionMode}
                onTextUnavailable={handleTextUnavailable}
                onAnnotationActivate={activateAnnotation}
                onBookmarkAdd={props.onBookmarkAdd}
                onBookmarkRemove={props.onBookmarkRemove}
                searchHighlight={activeSearchHit}
                onSize={handlePageSize}
                pagePreviews={pagePreviews}
                onPagePaint={retainPagePreview}
              />
            </div>
          </div>
        </div>
        {evidenceDrawerOpen && (
          <PdfEvidenceDrawer
            images={props.evidenceImages}
            texts={textEvidence}
            selectedImages={selectedEvidenceImages}
            selectedTexts={selectedTextEvidence}
            onImageSelectedChange={(image, selected) => {
              props.onEvidenceSelectionChange(
                selected
                  ? props.evidenceImages.filter(candidate => candidate === image || selectedEvidenceImages.includes(candidate))
                  : selectedEvidenceImages.filter(candidate => candidate !== image),
                selectedTextEvidenceIds,
              )
            }}
            onTextSelectedChange={(id, selected) => {
              const next = new Set(selectedTextEvidenceIds)
              if (selected) next.add(id)
              else next.delete(id)
              props.onEvidenceSelectionChange(selectedEvidenceImages, next)
            }}
            onSelectAll={() => {
              props.onEvidenceSelectionChange([...props.evidenceImages], new Set(textEvidence.map(source => source.id)))
            }}
            onDeselectAll={() => {
              props.onEvidenceSelectionChange([], new Set())
            }}
            onNavigateImage={props.onEvidenceNavigateImage}
            onRemoveImage={props.onEvidenceImageRemove}
            onNavigateText={props.onEvidenceNavigateText}
            onRemoveText={(id) => {
              if (activeEvidenceText?.id === id) clearEvidenceHighlight()
              const next = new Set(selectedTextEvidenceIds)
              next.delete(id)
              props.onEvidenceSelectionChange(selectedEvidenceImages, next)
              props.onTextEvidenceChange(textEvidence.filter(source => source.id !== id))
            }}
            onClear={() => {
              props.onEvidenceImagesClear()
              props.onTextEvidenceChange([])
              props.onEvidenceSelectionChange([], new Set())
              clearEvidenceHighlight()
              setMixedTextIntent(false)
              setEvidenceDrawerOpen(false)
            }}
            onAiRequest={submitEvidenceAiRequest}
            onClose={() => { setEvidenceDrawerOpen(false) }}
          />
        )}
        {annotationDrawerOpen && (
          <PdfAnnotationDrawer
            annotations={props.annotations}
            onNavigate={gotoAnnotation}
            onNoteChange={props.onTextMarkupNoteChange}
            onRemove={props.onTextMarkupRemove}
            onAiRequest={props.onAnnotationAiRequest}
            onClose={() => { setAnnotationDrawerOpen(false) }}
          />
        )}
        {thumbnailsOpen && (
          <PdfThumbnailDrawer
            doc={doc}
            currentPage={currentPage}
            documentRotation={documentRotation}
            pageRotations={pageRotations}
            onNavigate={navigateToPage}
            onClose={() => { setThumbnailsOpen(false) }}
          />
        )}
        <div
          ref={navigationControlsRef}
          data-pdf-navigation-controls="true"
          data-visible={navigationControlsVisible ? 'true' : 'false'}
          style={{
            ...styles.navigationControls,
            opacity: navigationControlsVisible ? 1 : 0,
            pointerEvents: navigationControlsVisible ? 'auto' : 'none',
          }}
          onFocusCapture={() => { revealCornerControl('navigation') }}
          onBlurCapture={(event) => {
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
              scheduleCornerControlHide('navigation')
            }
          }}
        >
          <div data-pdf-history-controls="true" role="group" aria-label="PDF 跳转历史" style={styles.floatingSurface}>
            <button
              type="button"
              aria-label="返回上一个 PDF 跳转位置"
              style={{
                ...styles.floatingButton,
                opacity: navigationAvailability.back ? 1 : 0.35,
                cursor: navigationAvailability.back ? 'pointer' : 'default',
              }}
              disabled={!navigationAvailability.back}
              onClick={() => { traverseNavigationHistory('back') }}
            >
              ←
            </button>
            <button
              type="button"
              aria-label="前进到下一个 PDF 跳转位置"
              style={{
                ...styles.floatingButton,
                opacity: navigationAvailability.forward ? 1 : 0.35,
                cursor: navigationAvailability.forward ? 'pointer' : 'default',
              }}
              disabled={!navigationAvailability.forward}
              onClick={() => { traverseNavigationHistory('forward') }}
            >
              →
            </button>
          </div>
          <div data-pdf-page-control="true" role="group" aria-label="PDF 页码" style={styles.floatingSurface}>
            {editingPage ? (
              <input
                ref={pageInputRef}
                type="number"
                min={1}
                max={doc.numPages}
                defaultValue={currentPage}
                aria-label="输入 PDF 页码"
                style={{ ...styles.pageControl, width: '76px', boxSizing: 'border-box', cursor: 'text', outline: 'none' }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    const value = Number(event.currentTarget.value)
                    if (Number.isFinite(value)) navigateToPage(value)
                    setEditingPage(false)
                  } else if (event.key === 'Escape') {
                    setEditingPage(false)
                  }
                }}
                onBlur={() => { setEditingPage(false) }}
                autoFocus
              />
            ) : (
              <button
                type="button"
                style={styles.pageControl}
                title="点击输入页码跳转"
                onClick={() => { setEditingPage(true) }}
              >
                {currentPage} / {doc.numPages}
              </button>
            )}
          </div>
        </div>
        <div
          ref={zoomControlsRef}
          data-pdf-zoom-controls="true"
          data-visible={zoomControlsVisible ? 'true' : 'false'}
          role="group"
          aria-label="PDF 缩放"
          style={{
            ...styles.floatingSurface,
            ...styles.zoomControls,
            opacity: zoomControlsVisible ? 1 : 0,
            pointerEvents: zoomControlsVisible ? 'auto' : 'none',
          }}
          onFocusCapture={() => { revealCornerControl('zoom') }}
          onBlurCapture={(event) => {
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
              scheduleCornerControlHide('zoom')
            }
          }}
        >
          <button
            type="button"
            aria-label="缩小"
            style={styles.floatingButton}
            onClick={() => {
              const current = zoomGestureActiveRef.current ? gestureZoomRef.current : zoomRef.current
              commitAnchoredZoom(current - PDF_ZOOM_STEP)
            }}
          >
            −
          </button>
          <button
            ref={zoomSpanRef}
            type="button"
            data-pdf-reset-zoom="true"
            aria-label="重置缩放"
            title={fitMode === 'width' ? '恢复适合宽度（100%）' : '恢复适合整页（100%）'}
            style={{ ...styles.floatingButton, ...styles.zoomLabel, width: 'auto' }}
            onClick={() => { commitAnchoredZoom(1) }}
          >
            {String(Math.round(zoom * 100))}%
          </button>
          <button
            type="button"
            aria-label="放大"
            style={styles.floatingButton}
            onClick={() => {
              const current = zoomGestureActiveRef.current ? gestureZoomRef.current : zoomRef.current
              commitAnchoredZoom(current + PDF_ZOOM_STEP)
            }}
          >
            ＋
          </button>
          <div ref={fitMenuRef} style={{ position: 'relative', display: 'flex' }}>
            <button
              type="button"
              data-pdf-fit-menu-button="true"
              aria-haspopup="menu"
              aria-expanded={fitMenuOpen}
              aria-label="页面适配方式"
              title={fitMode === 'width' ? '当前：适合宽度' : '当前：适合整页'}
              style={styles.floatingButton}
              onClick={() => {
                setSaveMenuOpen(false)
                setRotationMenuOpen(false)
                setFitMenuOpen(open => !open)
              }}
            >
              <FitPdfIcon />
            </button>
            {fitMenuOpen && (
              <div
                data-pdf-fit-menu="true"
                role="menu"
                aria-label="PDF 页面适配方式"
                style={{ ...styles.rotationMenu, top: 'auto', bottom: 'calc(100% + 6px)', right: 0 }}
              >
                <button
                  data-pdf-fit-width="true"
                  type="button"
                  role="menuitemradio"
                  aria-checked={fitMode === 'width'}
                  style={{ ...styles.rotationMenuItem, fontWeight: fitMode === 'width' ? 600 : 400 }}
                  onClick={() => { changeFitMode('width') }}
                >
                  {fitMode === 'width' ? '✓ ' : ''}适合宽度
                </button>
                <button
                  data-pdf-fit-page="true"
                  type="button"
                  role="menuitemradio"
                  aria-checked={fitMode === 'page'}
                  style={{ ...styles.rotationMenuItem, fontWeight: fitMode === 'page' ? 600 : 400 }}
                  onClick={() => { changeFitMode('page') }}
                >
                  {fitMode === 'page' ? '✓ ' : ''}适合整页
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {interactionNotice !== undefined && (
        <div role="status" style={{ color: '#595959', paddingTop: '4px', fontSize: '12px' }}>
          {interactionNotice}
        </div>
      )}
      {selectionError !== undefined && <div role="alert" style={{ color: '#d4380d', paddingTop: '4px', fontSize: '12px' }}>{selectionError}</div>}
    </>
  )

  // The reader window docks after the app's sidebar rail at a draggable
  // width — NON-modal (no backdrop), so the conversation on the right stays
  // live and clickable: ask from the window, watch the reply stream beside it.
  return createPortal(
    <div ref={widePanelRef} style={{
      ...styles.widePanel,
      // Keep the reader in the layout tree while closed. `display:none` would
      // force a long document to rebuild every page's geometry on reopen and
      // visibly travel back to scrollTop. Visibility removes paint/hit-testing
      // without invalidating layout or either scroll axis.
      visibility: wide ? 'visible' : 'hidden',
      pointerEvents: wide ? 'auto' : 'none',
      left: `${String(geometry.left)}px`,
      width: `${String(panelW)}px`,
    }}>
      {body}
      {geometry.overlay && navigationDrawer !== undefined && outlineController !== undefined && (
        <PdfOutlinePanel
          controller={outlineController}
          mode={navigationDrawer}
          onClose={() => { setNavigationDrawer(undefined) }}
          closeAfterNavigate
          closeLabel={navigationDrawer === 'search' ? '关闭 PDF 搜索' : '关闭 PDF 目录'}
          closeGlyph="×"
          style={{
            position: 'absolute',
            inset: '0 auto 0 0',
            zIndex: 40,
            width: 'min(320px, 86vw)',
            background: '#fff',
            color: '#262626',
            colorScheme: 'light',
            boxShadow: '4px 0 20px rgba(0,0,0,0.2)',
          }}
        />
      )}
      {!geometry.overlay && (
        <div
          style={styles.wideResizeHandle}
          title="拖动调整宽度"
          onPointerDown={startWideResize}
          onPointerMove={moveWideResize}
          onPointerUp={finishWideResize}
          onPointerCancel={finishWideResize}
        />
      )}
    </div>,
    document.body,
  )
}
