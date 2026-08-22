import {
  effectivePdfPageRotation,
  rotatePdfPageSize,
} from './pdf-rotation.ts'
import type { PdfPageRotation } from './pdf-rotation.ts'

/** Natural or fit-width page dimensions in CSS pixels. */
export interface PdfPageSize {
  width: number
  height: number
}

export interface PdfPageGeometry extends PdfPageSize {
  top: number
  left: number
}

export interface PdfPageStackLayout {
  width: number
  height: number
  layoutScale: number
  pages: readonly PdfPageGeometry[]
}

export const PDF_PAGE_GAP = 12
export const PDF_STACK_BOTTOM_PADDING = 12

function widestPdfPageWidth(
  defaultSize: PdfPageSize,
  knownSizes: Readonly<Record<number, PdfPageSize>>,
  documentRotation: PdfPageRotation,
  pageRotations: Readonly<Record<number, PdfPageRotation>>,
): number {
  let width = rotatePdfPageSize(defaultSize, documentRotation).width
  for (const [page, size] of Object.entries(knownSizes)) {
    if (size.width > 0 && size.height > 0) {
      const rotation = effectivePdfPageRotation(documentRotation, pageRotations[Number(page)])
      width = Math.max(width, rotatePdfPageSize(size, rotation).width)
    }
  }
  // An individually rotated, not-yet-measured page still participates in
  // fit-width using the same bounded fallback geometry as the page stack.
  for (const [page, rotation] of Object.entries(pageRotations)) {
    if (knownSizes[Number(page)] !== undefined) continue
    width = Math.max(
      width,
      rotatePdfPageSize(defaultSize, effectivePdfPageRotation(documentRotation, rotation)).width,
    )
  }
  return width
}

function tallestPdfPageHeight(
  defaultSize: PdfPageSize,
  knownSizes: Readonly<Record<number, PdfPageSize>>,
  documentRotation: PdfPageRotation,
  pageRotations: Readonly<Record<number, PdfPageRotation>>,
): number {
  let height = rotatePdfPageSize(defaultSize, documentRotation).height
  for (const [page, size] of Object.entries(knownSizes)) {
    if (size.width > 0 && size.height > 0) {
      const rotation = effectivePdfPageRotation(documentRotation, pageRotations[Number(page)])
      height = Math.max(height, rotatePdfPageSize(size, rotation).height)
    }
  }
  for (const [page, rotation] of Object.entries(pageRotations)) {
    if (knownSizes[Number(page)] !== undefined) continue
    height = Math.max(
      height,
      rotatePdfPageSize(defaultSize, effectivePdfPageRotation(documentRotation, rotation)).height,
    )
  }
  return height
}

/**
 * Fit the widest measured page into the reader while unknown pages retain the default size.
 * @param availableWidth - Reader viewport width in CSS pixels.
 * @param defaultSize - Natural size used for pages that have not been measured.
 * @param knownSizes - Natural sizes reported by mounted pdf.js pages.
 * @returns Global page-stack scale, or 1 before a usable width is available.
 */
export function pdfPageFitScale(
  availableWidth: number,
  defaultSize: PdfPageSize,
  knownSizes: Readonly<Record<number, PdfPageSize>>,
  documentRotation: PdfPageRotation = 0,
  pageRotations: Readonly<Record<number, PdfPageRotation>> = {},
): number {
  const widestPage = widestPdfPageWidth(defaultSize, knownSizes, documentRotation, pageRotations)
  return availableWidth > 0 && widestPage > 0 ? availableWidth / widestPage : 1
}

/** Fit every page inside one reader viewport while preserving continuous scroll. */
export function pdfPageFitPageScale(
  availableWidth: number,
  availableHeight: number,
  defaultSize: PdfPageSize,
  knownSizes: Readonly<Record<number, PdfPageSize>>,
  documentRotation: PdfPageRotation = 0,
  pageRotations: Readonly<Record<number, PdfPageRotation>> = {},
): number {
  const widestPage = widestPdfPageWidth(defaultSize, knownSizes, documentRotation, pageRotations)
  const tallestPage = tallestPdfPageHeight(defaultSize, knownSizes, documentRotation, pageRotations)
  if (!(availableWidth > 0) || !(availableHeight > 0) || !(widestPage > 0) || !(tallestPage > 0)) return 1
  return Math.min(availableWidth / widestPage, availableHeight / tallestPage)
}

/** Build the immutable, unzoomed geometry used by the bounded DOM window. */
export function pdfPageStackLayout(
  numPages: number,
  defaultSize: PdfPageSize,
  knownSizes: Readonly<Record<number, PdfPageSize>>,
  layoutScale: number,
  documentRotation: PdfPageRotation = 0,
  pageRotations: Readonly<Record<number, PdfPageRotation>> = {},
): PdfPageStackLayout {
  const naturalSizes = Array.from({ length: numPages }, (_, index) => {
    const known = knownSizes[index + 1]
    const size = known !== undefined && known.width > 0 && known.height > 0 ? known : defaultSize
    const rotation = effectivePdfPageRotation(documentRotation, pageRotations[index + 1])
    return rotatePdfPageSize(size, rotation)
  })
  const naturalMaxWidth = widestPdfPageWidth(defaultSize, knownSizes, documentRotation, pageRotations)
  const width = naturalMaxWidth * layoutScale
  let top = 0
  const pages = naturalSizes.map((size, index): PdfPageGeometry => {
    const pageWidth = size.width * layoutScale
    const pageHeight = size.height * layoutScale
    const geometry = {
      top,
      left: (width - pageWidth) / 2,
      width: pageWidth,
      height: pageHeight,
    }
    top += pageHeight
    if (index < numPages - 1) top += PDF_PAGE_GAP
    return geometry
  })
  return {
    width,
    height: top + PDF_STACK_BOTTOM_PADDING,
    layoutScale,
    pages,
  }
}

/** Find the page with the largest vertical share of one unzoomed viewport. */
export function visiblePdfPageNumber(
  pages: readonly PdfPageGeometry[],
  viewportTop: number,
  viewportHeight: number,
): number | undefined {
  if (pages.length === 0 || !(viewportHeight > 0)) return undefined
  const viewportBottom = viewportTop + viewportHeight
  let low = 0
  let high = pages.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const page = pages[middle]
    if (page !== undefined && page.top + page.height < viewportTop) low = middle + 1
    else high = middle
  }

  let bestIndex = low
  let bestRatio = -1
  for (let index = low; index < pages.length; index += 1) {
    const page = pages[index]
    if (page === undefined || page.top > viewportBottom) break
    const visible = Math.max(0, Math.min(page.top + page.height, viewportBottom) - Math.max(page.top, viewportTop))
    const ratio = visible / page.height
    if (ratio > bestRatio) {
      bestIndex = index
      bestRatio = ratio
    }
  }
  return bestIndex + 1
}
