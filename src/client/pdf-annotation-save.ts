/** Write session text markups into a copy of the source PDF as standard annotations. */

import {
  closePath,
  fill,
  LineCapStyle,
  lineTo,
  moveTo,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingColor,
  setGraphicsState,
  setLineCap,
  setLineWidth,
  setStrokingColor,
  stroke,
} from 'pdf-lib'
import { normalizePdfRotation, rotateNormalizedPdfPoint } from './pdf-rotation.ts'
import type { NormalizedPdfPoint, NormalizedPdfRect, PdfPageRotation } from './pdf-rotation.ts'
import { pdfMarkupColorOption } from './pdf-annotations.ts'
import { PDF_MARKUP_COLORS } from './pdf-annotations.ts'
import type {
  PdfMarkupColor,
  PdfMarkupStrokeWidth,
  PdfTextMarkupAnnotation,
  PdfTextMarkupKind,
} from './pdf-annotations.ts'
import { pdfBookmarkDescendantIds, validatePdfBookmarks } from './pdf-bookmarks.ts'
import type { PdfBookmark } from './pdf-bookmarks.ts'

interface PdfBox {
  x: number
  y: number
  width: number
  height: number
}

export interface PdfAnnotationPageGeometry {
  /** Visible page box in default PDF user-space coordinates. */
  visibleBox: PdfBox
  /** Intrinsic clockwise page rotation used by pdf.js before view-only rotation. */
  intrinsicRotation: PdfPageRotation
}

export interface PdfAnnotationPoint {
  x: number
  y: number
}

export interface PdfAnnotationQuad {
  topLeft: PdfAnnotationPoint
  topRight: PdfAnnotationPoint
  bottomLeft: PdfAnnotationPoint
  bottomRight: PdfAnnotationPoint
}

export interface PdfAnnotationSaveResult {
  bytes: Uint8Array
  annotationsWritten: number
  pagesTouched: number
}

export interface PdfEditableAnnotationLoadResult {
  /** Plugin-owned annotations restored into the editor model. */
  annotations: readonly PdfTextMarkupAnnotation[]
  /** Standard PDF outline entries restored into the editable bookmark model. */
  bookmarks: readonly PdfBookmark[]
  /**
   * A render-only PDF view with plugin annotations removed. When the source
   * contains no plugin annotations this is a zero-copy view of the input.
   */
  viewBytes: Uint8Array
}

export interface PdfAnnotationSaveOptions {
  /** Deterministic injection for tests; production defaults to the current time. */
  now?: Date
  /** Unique PDF annotation-name prefix; production defaults to a random UUID. */
  annotationNamespace?: string
  /** Replace the PDF outline only when bookmark editor state is dirty. */
  bookmarks?: readonly PdfBookmark[]
}

function assertNormalizedRect(rect: NormalizedPdfRect): void {
  const values = [rect.x, rect.y, rect.width, rect.height]
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > 1)
    || rect.width <= 0 || rect.height <= 0
    || rect.x + rect.width > 1.000_001 || rect.y + rect.height > 1.000_001) {
    throw new Error('PDF 批注包含无效页面坐标')
  }
}

function normalizedDisplayPointToPdf(
  point: NormalizedPdfPoint,
  geometry: PdfAnnotationPageGeometry,
): PdfAnnotationPoint {
  const unrotated = rotateNormalizedPdfPoint(
    point,
    normalizePdfRotation(-geometry.intrinsicRotation),
  )
  return {
    x: geometry.visibleBox.x + unrotated.x * geometry.visibleBox.width,
    y: geometry.visibleBox.y + (1 - unrotated.y) * geometry.visibleBox.height,
  }
}

/** Convert the canonical top-left display rectangle into PDF user-space quad points. */
export function normalizedPdfRectToAnnotationQuad(
  rect: NormalizedPdfRect,
  geometry: PdfAnnotationPageGeometry,
): PdfAnnotationQuad {
  assertNormalizedRect(rect)
  if (geometry.visibleBox.width <= 0 || geometry.visibleBox.height <= 0) {
    throw new Error('PDF 页面可见区域无效')
  }
  return {
    topLeft: normalizedDisplayPointToPdf({ x: rect.x, y: rect.y }, geometry),
    topRight: normalizedDisplayPointToPdf({ x: rect.x + rect.width, y: rect.y }, geometry),
    bottomLeft: normalizedDisplayPointToPdf({ x: rect.x, y: rect.y + rect.height }, geometry),
    bottomRight: normalizedDisplayPointToPdf({ x: rect.x + rect.width, y: rect.y + rect.height }, geometry),
  }
}

function normalizedBox(box: PdfBox): PdfBox {
  const x = Math.min(box.x, box.x + box.width)
  const y = Math.min(box.y, box.y + box.height)
  return { x, y, width: Math.abs(box.width), height: Math.abs(box.height) }
}

function visiblePageBox(mediaBox: PdfBox, cropBox: PdfBox): PdfBox {
  const media = normalizedBox(mediaBox)
  const crop = normalizedBox(cropBox)
  const left = Math.max(media.x, crop.x)
  const bottom = Math.max(media.y, crop.y)
  const right = Math.min(media.x + media.width, crop.x + crop.width)
  const top = Math.min(media.y + media.height, crop.y + crop.height)
  return right > left && top > bottom
    ? { x: left, y: bottom, width: right - left, height: top - bottom }
    : media
}

function annotationSubtype(kind: PdfTextMarkupKind): string {
  if (kind === 'underline') return 'Underline'
  if (kind === 'strikeout') return 'StrikeOut'
  return 'Highlight'
}

function annotationSubject(kind: PdfTextMarkupKind): string {
  if (kind === 'underline') return '下划线'
  if (kind === 'strikeout') return '删除线'
  return '高亮'
}

function quadPoints(quad: PdfAnnotationQuad): number[] {
  return [
    quad.topLeft.x, quad.topLeft.y,
    quad.topRight.x, quad.topRight.y,
    quad.bottomLeft.x, quad.bottomLeft.y,
    quad.bottomRight.x, quad.bottomRight.y,
  ]
}

function allQuadPoints(quads: readonly PdfAnnotationQuad[]): PdfAnnotationPoint[] {
  return quads.flatMap(quad => [quad.topLeft, quad.topRight, quad.bottomLeft, quad.bottomRight])
}

function boundsOfQuads(quads: readonly PdfAnnotationQuad[], padding: number): [number, number, number, number] {
  const points = allQuadPoints(quads)
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  return [
    Math.min(...xs) - padding,
    Math.min(...ys) - padding,
    Math.max(...xs) + padding,
    Math.max(...ys) + padding,
  ]
}

function interpolatePoint(from: PdfAnnotationPoint, to: PdfAnnotationPoint, ratio: number): PdfAnnotationPoint {
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  }
}

function cryptoUuid(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${String(Date.now())}-${Math.random().toString(16).slice(2)}`
}

const DSH_ANNOTATION_PREFIX = 'dsh-pdf-reader:'
const MAX_EDITABLE_PDF_ANNOTATIONS = 5_000
const MAX_EDITABLE_ANNOTATION_RECTS = 128
const MAX_EDITABLE_ANNOTATION_TEXT = 20_000
const MAX_EDITABLE_ANNOTATION_ID = 512
const MAX_EDITABLE_PDF_BOOKMARK_DEPTH = 128
/** Ceiling on name-tree pairs visited for one document's outline destinations. */
const MAX_NAMED_DESTINATION_SCAN = 200_000

function pdfText(dict: PDFDict, key: string): string | undefined {
  return dict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString)?.decodeText()
}

function pdfNumbers(dict: PDFDict, key: string, maxValues = 16): number[] | undefined {
  const array = dict.lookupMaybe(PDFName.of(key), PDFArray)
  if (array === undefined || array.size() > maxValues) return undefined
  const values = array.asArray().map(value => value instanceof PDFNumber ? value.asNumber() : Number.NaN)
  return values.every(Number.isFinite) ? values : undefined
}

function safelyDecodedPdfText(dict: PDFDict, key: string): string | undefined {
  try {
    return pdfText(dict, key)
  } catch {
    return undefined
  }
}

function outlineLinkedChildren(
  pdf: PDFDocument,
  parent: PDFDict,
  visited: Set<PDFDict>,
): readonly PDFDict[] {
  const children: PDFDict[] = []
  let current = pdf.context.lookupMaybe(parent.get(PDFName.of('First')), PDFDict)
  while (current !== undefined && children.length < 2_000 && !visited.has(current)) {
    visited.add(current)
    children.push(current)
    current = pdf.context.lookupMaybe(current.get(PDFName.of('Next')), PDFDict)
  }
  return children
}

function outlineDestinationPageNumber(
  pdf: PDFDocument,
  item: PDFDict,
  pageNumbersByRef: ReadonlyMap<string, number>,
  lookupNamedDestination: (name: string) => PDFArray | undefined,
): number | undefined {
  let destination = pdf.context.lookup(item.get(PDFName.of('Dest')))
  if (!(destination instanceof PDFArray)) {
    const action = item.lookupMaybe(PDFName.of('A'), PDFDict)
    if (action?.lookupMaybe(PDFName.of('S'), PDFName)?.decodeText() === 'GoTo') {
      destination = pdf.context.lookup(action.get(PDFName.of('D')))
    }
  }
  if (destination instanceof PDFName || destination instanceof PDFString || destination instanceof PDFHexString) {
    try {
      destination = lookupNamedDestination(destination.decodeText())
    } catch {
      destination = undefined
    }
  }
  if (!(destination instanceof PDFArray) || destination.size() === 0) return undefined
  const target = destination.get(0)
  if (target instanceof PDFRef) return pageNumbersByRef.get(target.tag)
  if (target instanceof PDFDict) {
    const ref = pdf.context.getObjectRef(target)
    return ref === undefined ? undefined : pageNumbersByRef.get(ref.tag)
  }
  // Some producers write a zero-based page index where the spec asks for a
  // page reference; accept it rather than dropping the bookmark.
  if (target instanceof PDFNumber) {
    const index = target.asNumber()
    return Number.isInteger(index) && index >= 0 && index < pdf.getPageCount() ? index + 1 : undefined
  }
  return undefined
}

function destinationArray(pdf: PDFDocument, value: PDFObject | undefined): PDFArray | undefined {
  const resolved = pdf.context.lookup(value)
  if (resolved instanceof PDFArray) return resolved
  if (resolved instanceof PDFDict) return resolved.lookupMaybe(PDFName.of('D'), PDFArray)
  return undefined
}

/**
 * Keys are read lazily, only for the destinations the outline actually names.
 *
 * A name tree is not a dictionary: its keys live in `Names` arrays spread over
 * `Kids`, so `/Dest (G2.9190)` can never be answered by a dict lookup. Producers
 * such as hyperref, Word, and FrameMaker publish thousands of anchors per
 * document, so a fixed scan cap silently loses the chapter destinations of
 * long manuals; filtering by the wanted set instead keeps the work bounded by
 * the outline while still reaching the last leaf.
 */
function createNamedDestinationLookup(
  pdf: PDFDocument,
  wantedNames: ReadonlySet<string>,
): (name: string) => PDFArray | undefined {
  const found = new Map<string, PDFArray>()
  const pending = new Set(wantedNames)
  const remember = (name: string, value: PDFObject | undefined): void => {
    if (!pending.has(name)) return
    const array = destinationArray(pdf, value)
    if (array === undefined) return
    found.set(name, array)
    pending.delete(name)
  }

  // The legacy Catalog/Dests dictionary is a plain map: O(1) per name.
  const legacy = pdf.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict)
  if (legacy !== undefined) {
    for (const name of [...pending]) remember(name, legacy.get(PDFName.of(name)))
  }

  // The standard name tree is walked once, keeping only wanted names.
  const tree = pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.lookupMaybe(PDFName.of('Dests'), PDFDict)
  if (tree !== undefined && pending.size > 0) {
    const visited = new Set<PDFDict>()
    const stack: PDFDict[] = [tree]
    let scanned = 0
    while (stack.length > 0 && pending.size > 0 && scanned < MAX_NAMED_DESTINATION_SCAN) {
      const node = stack.pop()
      if (node === undefined || visited.has(node)) continue
      visited.add(node)
      const entries = node.lookupMaybe(PDFName.of('Names'), PDFArray)
      if (entries !== undefined) {
        for (let index = 0
          ; index + 1 < entries.size() && pending.size > 0 && scanned < MAX_NAMED_DESTINATION_SCAN
          ; index += 2) {
          scanned += 1
          const key = entries.lookupMaybe(index, PDFString, PDFHexString)
          if (key === undefined) continue
          let name: string
          try {
            name = key.decodeText()
          } catch {
            continue
          }
          remember(name, entries.get(index + 1))
        }
      }
      const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray)
      if (kids !== undefined) {
        for (let index = kids.size() - 1; index >= 0; index -= 1) {
          const child = kids.lookupMaybe(index, PDFDict)
          if (child !== undefined) stack.push(child)
        }
      }
    }
  }
  return name => found.get(name)
}

/**
 * The named destination one outline entry points at, when it uses the string
 * form (`/Dest (anchor)` or `/A << /S /GoTo /D (anchor) >>`).
 */
function outlineDestinationName(pdf: PDFDocument, item: PDFDict): string | undefined {
  const action = item.lookupMaybe(PDFName.of('A'), PDFDict)
  const direct = pdf.context.lookup(item.get(PDFName.of('Dest')))
  const candidate = direct ?? pdf.context.lookup(action?.get(PDFName.of('D')))
  if (candidate instanceof PDFName || candidate instanceof PDFString || candidate instanceof PDFHexString) {
    try {
      return candidate.decodeText()
    } catch {
      return undefined
    }
  }
  return undefined
}

function outlineUri(item: PDFDict): string | undefined {
  const action = item.lookupMaybe(PDFName.of('A'), PDFDict)
  if (action?.lookupMaybe(PDFName.of('S'), PDFName)?.decodeText() !== 'URI') return undefined
  return safelyDecodedPdfText(action, 'URI')
}

/** One outline entry collected before any destination is resolved. */
interface PdfOutlineRecord {
  readonly item: PDFDict
  readonly id: string
  readonly parentId: string | null
  readonly depth: number
  /** Named destination this entry points at, when it uses the string form. */
  readonly destinationName: string | undefined
}

/**
 * Read the common internal-page and URI forms of the standard PDF outline.
 *
 * Two passes: the first walks the tree and collects the named destinations the
 * entries reference, the second resolves them (a name tree cannot be searched
 * one key at a time cheaply) and builds the bookmark rows.
 */
function loadPdfBookmarks(
  pdf: PDFDocument,
  sourceDictionaries?: Map<string, PDFDict>,
): readonly PdfBookmark[] {
  const root = pdf.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict)
  if (root === undefined) return []
  const visited = new Set<PDFDict>()
  const usedIds = new Set<string>()
  const records: PdfOutlineRecord[] = []
  const roots = outlineLinkedChildren(pdf, root, visited)
  const stack = roots.map((item, index) => ({
    item,
    parentId: null as string | null,
    path: String(index + 1),
    depth: 0,
  })).reverse()

  while (stack.length > 0 && records.length < 2_000) {
    const current = stack.pop()
    if (current === undefined) break
    const storedId = safelyDecodedPdfText(current.item, 'DSHId')?.slice(0, 512)
    const objectId = pdf.context.getObjectRef(current.item)?.tag
    const baseId = storedId || objectId || `outline-${current.path}`
    let id = baseId
    let suffix = 2
    while (usedIds.has(id)) id = `${baseId}-${String(suffix++)}`.slice(0, 512)
    usedIds.add(id)
    records.push({
      item: current.item,
      id,
      parentId: current.parentId,
      depth: current.depth,
      destinationName: outlineDestinationName(pdf, current.item),
    })
    if (current.depth >= MAX_EDITABLE_PDF_BOOKMARK_DEPTH) continue
    const children = outlineLinkedChildren(pdf, current.item, visited)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child !== undefined) {
        stack.push({
          item: child,
          parentId: id,
          path: `${current.path}.${String(index + 1)}`,
          depth: current.depth + 1,
        })
      }
    }
  }

  const wantedNames = new Set(records.flatMap(record => (
    record.destinationName === undefined ? [] : [record.destinationName]
  )))
  const lookupNamedDestination = createNamedDestinationLookup(pdf, wantedNames)
  const pageNumbersByRef = new Map(pdf.getPages().map((page, index) => [page.ref.tag, index + 1]))
  const bookmarks: PdfBookmark[] = []
  for (const record of records) {
    const { item } = record
    const pageNumber = outlineDestinationPageNumber(pdf, item, pageNumbersByRef, lookupNamedDestination)
    const url = outlineUri(item)
    const preserveSourceAction = pageNumber === undefined && url === undefined
      && (item.has(PDFName.of('Dest')) || item.has(PDFName.of('A')))
    const flags = item.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0
    const color = pdfNumbers(item, 'C', 3)
    bookmarks.push({
      id: record.id,
      parentId: record.parentId,
      title: (safelyDecodedPdfText(item, 'Title')?.trim() || '未命名书签').slice(0, 500),
      ...(pageNumber === undefined ? {} : { pageNumber }),
      ...(url === undefined ? {} : { url: url.slice(0, 8_192) }),
      ...(Boolean(flags & 2) ? { bold: true } : {}),
      ...(Boolean(flags & 1) ? { italic: true } : {}),
      ...(color !== undefined && color.length === 3
        && color.every(component => component >= 0 && component <= 1)
        ? { color: [color[0]!, color[1]!, color[2]!] as const }
        : {}),
      ...(preserveSourceAction ? { preserveSourceAction: true } : {}),
    })
    sourceDictionaries?.set(record.id, item)
  }
  return bookmarks
}

function replacePdfBookmarks(pdf: PDFDocument, bookmarks: readonly PdfBookmark[]): void {
  const pages = pdf.getPages()
  validatePdfBookmarks(bookmarks, pages.length)
  const sourceDictionaries = new Map<string, PDFDict>()
  loadPdfBookmarks(pdf, sourceDictionaries)
  const outlinesName = PDFName.of('Outlines')
  if (bookmarks.length === 0) {
    pdf.catalog.delete(outlinesName)
    return
  }

  const root = pdf.context.obj({ Type: 'Outlines' })
  const rootRef = pdf.context.register(root)
  const dictionaries = new Map<string, PDFDict>()
  const references = new Map<string, PDFRef>()
  for (const bookmark of bookmarks) {
    const flags = (bookmark.italic === true ? 1 : 0) | (bookmark.bold === true ? 2 : 0)
    const dictionary = pdf.context.obj({
      Title: PDFHexString.fromText(bookmark.title),
      DSHId: PDFHexString.fromText(bookmark.id),
      ...(flags === 0 ? {} : { F: flags }),
      ...(bookmark.color === undefined ? {} : { C: [...bookmark.color] }),
    })
    if (bookmark.pageNumber !== undefined) {
      dictionary.set(PDFName.of('Dest'), pdf.context.obj([pages[bookmark.pageNumber - 1]!.ref, 'Fit']))
    } else if (bookmark.url !== undefined) {
      dictionary.set(PDFName.of('A'), pdf.context.obj({
        S: 'URI',
        // URI actions are byte strings; UTF-16 text hex strings are exposed
        // as a garbled unsafeUrl by common PDF viewers.
        URI: PDFString.of(bookmark.url),
      }))
    } else if (bookmark.preserveSourceAction === true) {
      const source = sourceDictionaries.get(bookmark.id)
      const destination = source?.get(PDFName.of('Dest'))
      const action = source?.get(PDFName.of('A'))
      if (destination !== undefined) dictionary.set(PDFName.of('Dest'), destination)
      if (action !== undefined) dictionary.set(PDFName.of('A'), action)
    }
    dictionaries.set(bookmark.id, dictionary)
    references.set(bookmark.id, pdf.context.register(dictionary))
  }

  const childrenByParent = new Map<string | null, PdfBookmark[]>()
  for (const bookmark of bookmarks) {
    const siblings = childrenByParent.get(bookmark.parentId) ?? []
    siblings.push(bookmark)
    childrenByParent.set(bookmark.parentId, siblings)
  }
  for (const [parentId, children] of childrenByParent) {
    const parent = parentId === null ? root : dictionaries.get(parentId)!
    parent.set(PDFName.of('First'), references.get(children[0]!.id)!)
    parent.set(PDFName.of('Last'), references.get(children[children.length - 1]!.id)!)
    for (const [index, child] of children.entries()) {
      const dictionary = dictionaries.get(child.id)!
      dictionary.set(PDFName.of('Parent'), parentId === null ? rootRef : references.get(parentId)!)
      const previous = children[index - 1]
      const next = children[index + 1]
      if (previous !== undefined) dictionary.set(PDFName.of('Prev'), references.get(previous.id)!)
      if (next !== undefined) dictionary.set(PDFName.of('Next'), references.get(next.id)!)
    }
  }
  for (const bookmark of bookmarks) {
    const descendantCount = pdfBookmarkDescendantIds(bookmarks, bookmark.id).size
    if (descendantCount > 0) dictionaries.get(bookmark.id)!.set(PDFName.of('Count'), PDFNumber.of(descendantCount))
  }
  root.set(PDFName.of('Count'), PDFNumber.of(bookmarks.length))
  pdf.catalog.set(outlinesName, rootRef)
}

function editableAnnotationKind(dict: PDFDict): PdfTextMarkupKind | undefined {
  const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText()
  if (subtype === 'Highlight') return 'highlight'
  if (subtype === 'Underline') return 'underline'
  if (subtype === 'StrikeOut') return 'strikeout'
  return undefined
}

function isDshAnnotation(dict: PDFDict): boolean {
  return pdfText(dict, 'NM')?.startsWith(DSH_ANNOTATION_PREFIX) === true
}

function nearestMarkupColor(components: readonly number[]): PdfMarkupColor {
  let nearest = PDF_MARKUP_COLORS[0]!
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const option of PDF_MARKUP_COLORS) {
    const distance = option.pdfRgb.reduce((sum, component, index) => {
      const delta = component - (components[index] ?? 0)
      return sum + delta * delta
    }, 0)
    if (distance < nearestDistance) {
      nearest = option
      nearestDistance = distance
    }
  }
  return nearest.id
}

function strokeWidthFromAnnotation(dict: PDFDict): PdfMarkupStrokeWidth {
  const custom = dict.lookupMaybe(PDFName.of('DSHStrokeWidth'), PDFNumber)?.asNumber()
  const border = dict.lookupMaybe(PDFName.of('BS'), PDFDict)
  const standard = border?.lookupMaybe(PDFName.of('W'), PDFNumber)?.asNumber()
  const width = custom ?? standard ?? 1
  if (width >= 2.5) return 3
  if (width >= 1.5) return 2
  return 1
}

function pdfPointToNormalizedDisplay(
  point: PdfAnnotationPoint,
  geometry: PdfAnnotationPageGeometry,
): NormalizedPdfPoint {
  const unrotated = {
    x: (point.x - geometry.visibleBox.x) / geometry.visibleBox.width,
    y: 1 - (point.y - geometry.visibleBox.y) / geometry.visibleBox.height,
  }
  return rotateNormalizedPdfPoint(unrotated, geometry.intrinsicRotation)
}

function normalizedRectFromQuad(
  points: readonly PdfAnnotationPoint[],
  geometry: PdfAnnotationPageGeometry,
): NormalizedPdfRect | undefined {
  const normalized = points.map(point => pdfPointToNormalizedDisplay(point, geometry))
  const xs = normalized.map(point => point.x)
  const ys = normalized.map(point => point.y)
  const left = Math.max(0, Math.min(...xs))
  const top = Math.max(0, Math.min(...ys))
  const right = Math.min(1, Math.max(...xs))
  const bottom = Math.min(1, Math.max(...ys))
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return undefined
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function annotationRects(dict: PDFDict, geometry: PdfAnnotationPageGeometry): readonly NormalizedPdfRect[] {
  const quadNumbers = pdfNumbers(dict, 'QuadPoints', MAX_EDITABLE_ANNOTATION_RECTS * 8)
  if (quadNumbers !== undefined && quadNumbers.length >= 8 && quadNumbers.length % 8 === 0) {
    const rects: NormalizedPdfRect[] = []
    for (let index = 0; index < quadNumbers.length; index += 8) {
      const points = [0, 2, 4, 6].map(offset => ({
        x: quadNumbers[index + offset]!,
        y: quadNumbers[index + offset + 1]!,
      }))
      const rect = normalizedRectFromQuad(points, geometry)
      if (rect !== undefined) rects.push(rect)
    }
    if (rects.length > 0) return rects
  }

  const rect = pdfNumbers(dict, 'Rect', 4)
  if (rect === undefined || rect.length !== 4) return []
  return [normalizedRectFromQuad([
    { x: rect[0]!, y: rect[1]! },
    { x: rect[2]!, y: rect[1]! },
    { x: rect[0]!, y: rect[3]! },
    { x: rect[2]!, y: rect[3]! },
  ], geometry)].filter((value): value is NormalizedPdfRect => value !== undefined)
}

/** Restore annotations created by this plugin and strip them only from the render copy. */
export async function loadPdfTextMarkupAnnotations(
  source: ArrayBuffer | Uint8Array,
): Promise<PdfEditableAnnotationLoadResult> {
  const pdf = await PDFDocument.load(source, { updateMetadata: false })
  const annotations: PdfTextMarkupAnnotation[] = []
  const bookmarks = loadPdfBookmarks(pdf)
  let strippedPluginAnnotation = false
  let pluginAnnotationCount = 0

  for (const [pageIndex, page] of pdf.getPages().entries()) {
    const annots = page.node.Annots()
    if (annots === undefined) continue
    const removableIndexes: number[] = []
    const geometry: PdfAnnotationPageGeometry = {
      visibleBox: visiblePageBox(page.getMediaBox(), page.getCropBox()),
      intrinsicRotation: normalizePdfRotation(page.getRotation().angle),
    }
    for (let index = 0; index < annots.size(); index += 1) {
      const dict = annots.lookupMaybe(index, PDFDict)
      if (dict === undefined || !isDshAnnotation(dict)) continue
      pluginAnnotationCount += 1
      if (pluginAnnotationCount > MAX_EDITABLE_PDF_ANNOTATIONS) {
        throw new Error(`PDF 中的可编辑批注过多（最多 ${String(MAX_EDITABLE_PDF_ANNOTATIONS)} 条）`)
      }
      removableIndexes.push(index)
      const kind = editableAnnotationKind(dict)
      const rects = kind === undefined || annotations.length >= MAX_EDITABLE_PDF_ANNOTATIONS
        ? []
        : annotationRects(dict, geometry)
      if (kind !== undefined && rects.length > 0 && annotations.length < MAX_EDITABLE_PDF_ANNOTATIONS) {
        const name = (pdfText(dict, 'NM') ?? `${DSH_ANNOTATION_PREFIX}legacy:${String(pageIndex + 1)}:${String(index + 1)}`)
          .slice(0, MAX_EDITABLE_ANNOTATION_ID)
        const groupId = (pdfText(dict, 'DSHGroup') ?? `${name}:group`).slice(0, MAX_EDITABLE_ANNOTATION_ID)
        annotations.push({
          id: (pdfText(dict, 'DSHId') ?? `${groupId}:p${String(pageIndex + 1)}:${String(index + 1)}`).slice(0, MAX_EDITABLE_ANNOTATION_ID),
          groupId,
          kind,
          pageNumber: pageIndex + 1,
          rects,
          text: (pdfText(dict, 'DSHText') ?? '').slice(0, MAX_EDITABLE_ANNOTATION_TEXT),
          note: (pdfText(dict, 'Contents') ?? '').slice(0, 2_000),
          color: nearestMarkupColor(pdfNumbers(dict, 'C') ?? PDF_MARKUP_COLORS[0]!.pdfRgb),
          strokeWidth: strokeWidthFromAnnotation(dict),
        })
      }
      // Even malformed plugin-owned annotations are removed from the view
      // copy, otherwise a repaired version could be painted twice later.
    }
    if (removableIndexes.length > 0) strippedPluginAnnotation = true
    for (const index of removableIndexes.reverse()) annots.remove(index)
  }

  // Re-serializing a large, ordinary PDF creates another complete byte copy
  // and makes pdf-lib retain a large object graph for longer. Most documents
  // have no plugin annotations, so let the reader share the immutable source
  // buffer and only create a stripped copy when double-painting is possible.
  const viewBytes = strippedPluginAnnotation
    ? await pdf.save()
    : source instanceof Uint8Array
      ? source
      : new Uint8Array(source)
  return { annotations, bookmarks, viewBytes }
}

function removeExistingDshAnnotations(pdf: PDFDocument): void {
  for (const page of pdf.getPages()) {
    const annots = page.node.Annots()
    if (annots === undefined) continue
    for (let index = annots.size() - 1; index >= 0; index -= 1) {
      const dict = annots.lookupMaybe(index, PDFDict)
      if (dict !== undefined && isDshAnnotation(dict)) annots.remove(index)
    }
  }
}

/** Serialize current session markups into a new byte array; source bytes are never mutated. */
export async function savePdfTextMarkupAnnotations(
  source: ArrayBuffer | Uint8Array,
  annotations: readonly PdfTextMarkupAnnotation[],
  options: PdfAnnotationSaveOptions = {},
): Promise<PdfAnnotationSaveResult> {
  if (annotations.length > MAX_EDITABLE_PDF_ANNOTATIONS) {
    throw new Error(`PDF 批注过多（最多 ${String(MAX_EDITABLE_PDF_ANNOTATIONS)} 条）`)
  }
  for (const annotation of annotations) {
    if (annotation.rects.length > MAX_EDITABLE_ANNOTATION_RECTS) {
      throw new Error(`单条 PDF 批注区域过多（最多 ${String(MAX_EDITABLE_ANNOTATION_RECTS)} 个）`)
    }
    if (annotation.text.length > MAX_EDITABLE_ANNOTATION_TEXT
      || annotation.id.length > MAX_EDITABLE_ANNOTATION_ID
      || annotation.groupId.length > MAX_EDITABLE_ANNOTATION_ID
      || annotation.note.length > 2_000) {
      throw new Error('PDF 批注文字或标识超过安全上限')
    }
  }
  let pdf: PDFDocument
  try {
    pdf = await PDFDocument.load(source, { updateMetadata: false })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/encrypted/i.test(message)) throw new Error('当前暂不支持把批注写入加密 PDF')
    throw new Error(`无法打开 PDF 进行保存：${message}`)
  }

  const pages = pdf.getPages()
  // Saving is an editor-state replacement, not an append-only export. This
  // keeps repeated saves and reopened documents from accumulating duplicates.
  removeExistingDshAnnotations(pdf)
  if (options.bookmarks !== undefined) replacePdfBookmarks(pdf, options.bookmarks)
  const now = options.now ?? new Date()
  const namespace = options.annotationNamespace ?? cryptoUuid()
  const pagesTouched = new Set<number>()
  let annotationsWritten = 0

  for (const [annotationIndex, annotation] of annotations.entries()) {
    if (!Number.isSafeInteger(annotation.pageNumber)
      || annotation.pageNumber < 1 || annotation.pageNumber > pages.length) {
      throw new Error(`PDF 批注页码无效：${String(annotation.pageNumber)}`)
    }
    if (annotation.rects.length === 0) continue
    const page = pages[annotation.pageNumber - 1]!
    const geometry: PdfAnnotationPageGeometry = {
      visibleBox: visiblePageBox(page.getMediaBox(), page.getCropBox()),
      intrinsicRotation: normalizePdfRotation(page.getRotation().angle),
    }
    const quads = annotation.rects.map(rect => normalizedPdfRectToAnnotationQuad(rect, geometry))
    const color = pdfMarkupColorOption(annotation.color)
    const padding = annotation.kind === 'highlight' ? 0 : annotation.strokeWidth / 2 + 0.5
    const rect = boundsOfQuads(quads, padding)
    const rectWidth = rect[2] - rect[0]
    const rectHeight = rect[3] - rect[1]
    const local = (point: PdfAnnotationPoint): PdfAnnotationPoint => ({
      x: point.x - rect[0],
      y: point.y - rect[1],
    })

    const alpha = annotation.kind === 'highlight' ? 0.46 : 1
    const graphicState = pdf.context.obj({
      Type: 'ExtGState',
      CA: alpha,
      ca: alpha,
      BM: annotation.kind === 'highlight' ? 'Multiply' : 'Normal',
    })
    const graphicStateRef = pdf.context.register(graphicState)
    const operators = [pushGraphicsState(), setGraphicsState('GS0')]
    const appearanceColor = rgb(...color.pdfRgb)
    if (annotation.kind === 'highlight') {
      operators.push(setFillingColor(appearanceColor))
      for (const quad of quads) {
        const topLeft = local(quad.topLeft)
        const topRight = local(quad.topRight)
        const bottomRight = local(quad.bottomRight)
        const bottomLeft = local(quad.bottomLeft)
        operators.push(
          moveTo(topLeft.x, topLeft.y),
          lineTo(topRight.x, topRight.y),
          lineTo(bottomRight.x, bottomRight.y),
          lineTo(bottomLeft.x, bottomLeft.y),
          closePath(),
          fill(),
        )
      }
    } else {
      operators.push(
        setStrokingColor(appearanceColor),
        setLineWidth(annotation.strokeWidth),
        setLineCap(LineCapStyle.Round),
      )
      const verticalRatio = annotation.kind === 'underline' ? 0.92 : 0.5
      for (const quad of quads) {
        const left = local(interpolatePoint(quad.topLeft, quad.bottomLeft, verticalRatio))
        const right = local(interpolatePoint(quad.topRight, quad.bottomRight, verticalRatio))
        operators.push(moveTo(left.x, left.y), lineTo(right.x, right.y), stroke())
      }
    }
    operators.push(popGraphicsState())
    const appearance = pdf.context.formXObject(operators, {
      BBox: pdf.context.obj([0, 0, rectWidth, rectHeight]),
      Resources: pdf.context.obj({ ExtGState: { GS0: graphicStateRef } }),
    })
    const appearanceRef = pdf.context.register(appearance)

    const annotationDict = pdf.context.obj({
      Type: 'Annot',
      Subtype: annotationSubtype(annotation.kind),
      Rect: rect,
      QuadPoints: quads.flatMap(quadPoints),
      C: [...color.pdfRgb],
      CA: alpha,
      F: 4,
      P: page.ref,
      T: PDFHexString.fromText('DeepSeek PDF Reader'),
      Subj: PDFHexString.fromText(annotationSubject(annotation.kind)),
      NM: PDFHexString.fromText(`${DSH_ANNOTATION_PREFIX}${namespace}:${String(annotationIndex + 1)}`),
      DSHSchema: 1,
      DSHGroup: PDFHexString.fromText(annotation.groupId),
      DSHId: PDFHexString.fromText(annotation.id),
      DSHText: PDFHexString.fromText(annotation.text),
      DSHStrokeWidth: annotation.strokeWidth,
      M: PDFString.fromDate(now),
      CreationDate: PDFString.fromDate(now),
      ...(annotation.note.length === 0 ? {} : { Contents: PDFHexString.fromText(annotation.note) }),
      ...(annotation.kind === 'highlight'
        ? {}
        : { BS: { Type: 'Border', W: annotation.strokeWidth, S: 'S' } }),
      AP: { N: appearanceRef },
    })
    const annotationRef = pdf.context.register(annotationDict)
    page.node.addAnnot(annotationRef)
    pagesTouched.add(annotation.pageNumber)
    annotationsWritten += 1
  }

  const bytes = await pdf.save()
  return { bytes, annotationsWritten, pagesTouched: pagesTouched.size }
}
