import { MAX_CANVAS_DIMENSION } from '../limits.ts'

/** Cap both canvas axes, including portrait-page height. */
export function constrainedPaintScale(width: number, height: number, requestedScale: number): number {
  const naturalMax = Math.max(1, width, height)
  return Math.min(requestedScale, MAX_CANVAS_DIMENSION / naturalMax)
}
/** Number of decoded bytes represented by a canonical padded Base64 string. */
export function base64ByteLength(data: string): number {
  if (data.length === 0) return 0
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor(data.length * 3 / 4) - padding
}

/** Fit raster dimensions within a pixel-count boundary while preserving ratio. */
export function fitWithinPixels(width: number, height: number, maxPixels: number): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  const pixels = safeWidth * safeHeight
  if (pixels <= maxPixels) return { width: safeWidth, height: safeHeight }
  const scale = Math.sqrt(maxPixels / pixels)
  return {
    width: Math.max(1, Math.floor(safeWidth * scale)),
    height: Math.max(1, Math.floor(safeHeight * scale)),
  }
}
