/** Non-destructive view rotation helpers shared by layout and page overlays. */

export type PdfPageRotation = 0 | 90 | 180 | 270

export interface NormalizedPdfPoint {
  x: number
  y: number
}

export interface NormalizedPdfRect extends NormalizedPdfPoint {
  width: number
  height: number
}

export interface RotatablePdfPageSize {
  width: number
  height: number
}

/** Normalize arbitrary quarter-turn arithmetic into pdf.js' clockwise domain. */
export function normalizePdfRotation(rotation: number): PdfPageRotation {
  const normalized = ((rotation % 360) + 360) % 360
  if (normalized === 90 || normalized === 180 || normalized === 270) return normalized
  return 0
}

/** Compose the document-wide view rotation with one page-local adjustment. */
export function effectivePdfPageRotation(
  documentRotation: PdfPageRotation,
  pageRotation = 0,
): PdfPageRotation {
  return normalizePdfRotation(documentRotation + pageRotation)
}

/** Swap the natural axes for odd quarter turns without mutating source geometry. */
export function rotatePdfPageSize<T extends RotatablePdfPageSize>(
  size: T,
  rotation: PdfPageRotation,
): RotatablePdfPageSize {
  return rotation === 90 || rotation === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height }
}

/** Rotate one normalized page point clockwise around the page bounds. */
export function rotateNormalizedPdfPoint(
  point: NormalizedPdfPoint,
  rotation: PdfPageRotation,
): NormalizedPdfPoint {
  switch (rotation) {
    case 90: return { x: 1 - point.y, y: point.x }
    case 180: return { x: 1 - point.x, y: 1 - point.y }
    case 270: return { x: point.y, y: 1 - point.x }
    default: return { x: point.x, y: point.y }
  }
}

/** Rotate an axis-aligned normalized crop into another quarter-turn view. */
export function rotateNormalizedPdfRect(
  rect: NormalizedPdfRect,
  rotation: PdfPageRotation,
): NormalizedPdfRect {
  switch (rotation) {
    case 90:
      return { x: 1 - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width }
    case 180:
      return { x: 1 - rect.x - rect.width, y: 1 - rect.y - rect.height, width: rect.width, height: rect.height }
    case 270:
      return { x: rect.y, y: 1 - rect.x - rect.width, width: rect.height, height: rect.width }
    default:
      return { ...rect }
  }
}
