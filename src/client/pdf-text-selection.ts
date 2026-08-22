export interface PdfTextSelectionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PdfTextLineFragment {
  left: number
  top: number
  right: number
  bottom: number
}

export interface PdfTextSelectionPoint {
  x: number
  y: number
}

export interface PdfTextBlankCaretTarget {
  fragmentIndex: number
  /** Visual edge, independent of the fragment's writing direction. */
  edge: 'left' | 'right'
}

interface PdfTextLineSegment {
  indexes: number[]
  left: number
  top: number
  right: number
  bottom: number
}

function pdfTextLineSegments(fragments: readonly PdfTextLineFragment[]): PdfTextLineSegment[] {
  const segments: PdfTextLineSegment[] = []
  fragments.forEach((fragment, index) => {
    const width = fragment.right - fragment.left
    const height = fragment.bottom - fragment.top
    if (width <= 0 || height <= 0) return
    const center = fragment.top + height / 2
    const line = segments.find((candidate) => {
      const candidateHeight = candidate.bottom - candidate.top
      const candidateCenter = candidate.top + candidateHeight / 2
      if (Math.abs(center - candidateCenter) > Math.max(height, candidateHeight) * 0.55) return false
      const gap = fragment.left > candidate.right
        ? fragment.left - candidate.right
        : candidate.left > fragment.right
          ? candidate.left - fragment.right
          : 0
      return gap <= Math.max(height, candidateHeight) * 1.5
    })
    if (line === undefined) {
      segments.push({ indexes: [index], ...fragment })
      return
    }
    line.indexes.push(index)
    line.left = Math.min(line.left, fragment.left)
    line.top = Math.min(line.top, fragment.top)
    line.right = Math.max(line.right, fragment.right)
    line.bottom = Math.max(line.bottom, fragment.bottom)
  })
  return segments
}

/**
 * Lock a pointer to one visual line before considering its horizontal
 * position. Adjacent PDF text rows have overlapping hit slop; looking for a
 * glyph across every eligible row first makes a blank on the current row
 * resolve to an unrelated word below it.
 */
export function pdfTextClosestLineFragmentIndexes(
  fragments: readonly PdfTextLineFragment[],
  point: PdfTextSelectionPoint,
): readonly number[] {
  const eligible = pdfTextLineSegments(fragments).flatMap((segment) => {
    const height = segment.bottom - segment.top
    const verticalSlack = height * 0.3
    if (point.y < segment.top - verticalSlack || point.y > segment.bottom + verticalSlack) return []
    const center = segment.top + height / 2
    const horizontalDistance = point.x < segment.left
      ? segment.left - point.x
      : point.x > segment.right
        ? point.x - segment.right
        : 0
    return [{
      segment,
      verticalDistance: Math.abs(point.y - center) / height,
      horizontalDistance,
    }]
  }).sort((left, right) => (
    left.verticalDistance - right.verticalDistance
      || left.horizontalDistance - right.horizontalDistance
  ))
  return eligible[0]?.segment.indexes ?? []
}

/**
 * Resolve leading, inter-fragment, and trailing whitespace to the nearest
 * visual text boundary on the same line. Browsers otherwise resolve blank
 * pdf.js text-layer space to an unrelated DOM line or paragraph.
 *
 * Same-height fragments are split at column-sized gaps, so the blank area
 * after a left-column line never snaps to an unrelated right column.
 */
export function pdfTextBlankCaretTarget(
  fragments: readonly PdfTextLineFragment[],
  point: PdfTextSelectionPoint,
): PdfTextBlankCaretTarget | undefined {
  const lineIndexes = pdfTextClosestLineFragmentIndexes(fragments, point)
  // One physical pixel avoids fighting the browser while the pointer is
  // still over a glyph. The row is chosen first so a neighboring row cannot
  // claim a blank in the current one.
  if (lineIndexes.some((index) => {
    const fragment = fragments[index]!
    return point.x >= fragment.left - 1 && point.x <= fragment.right + 1
  })) return undefined

  const candidates = lineIndexes.flatMap((index) => {
    const fragment = fragments[index]!
    return [
      { fragmentIndex: index, edge: 'left' as const, horizontalDistance: Math.abs(point.x - fragment.left) },
      { fragmentIndex: index, edge: 'right' as const, horizontalDistance: Math.abs(point.x - fragment.right) },
    ]
  }).sort((left, right) => (
    left.horizontalDistance - right.horizontalDistance
      || (left.edge === 'right' ? -1 : 1)
  ))
  const target = candidates[0]
  return target === undefined
    ? undefined
    : { fragmentIndex: target.fragmentIndex, edge: target.edge }
}

/**
 * Merge adjacent browser selection fragments on the same text line.
 *
 * pdf.js positions many words in separate absolute spans. Browsers paint a
 * translucent ::selection background for every span, producing dark seams
 * where neighboring fragments overlap. A single union rectangle removes the
 * seams and fills ordinary word spaces, while the line-height gap limit keeps
 * unrelated columns separate.
 */
export function mergePdfTextSelectionRects(
  rects: readonly PdfTextSelectionRect[],
): readonly PdfTextSelectionRect[] {
  const sorted = rects
    .filter(rect => rect.width > 0 && rect.height > 0)
    .map(rect => ({ ...rect }))
    .sort((left, right) => left.y - right.y || left.x - right.x)
  let pending = sorted
  while (true) {
    const merged: PdfTextSelectionRect[] = []
    for (const rect of pending) {
      const rectCenter = rect.y + rect.height / 2
      const line = merged.find((candidate) => {
        const candidateCenter = candidate.y + candidate.height / 2
        const sameLine = Math.abs(rectCenter - candidateCenter) <= Math.max(rect.height, candidate.height) * 0.55
        if (!sameLine) return false
        const gap = rect.x > candidate.x
          ? rect.x - (candidate.x + candidate.width)
          : candidate.x - (rect.x + rect.width)
        return gap <= Math.max(rect.height, candidate.height) * 1.5
      })
      if (line === undefined) {
        merged.push({ ...rect })
        continue
      }
      const left = Math.min(line.x, rect.x)
      const top = Math.min(line.y, rect.y)
      const right = Math.max(line.x + line.width, rect.x + rect.width)
      const bottom = Math.max(line.y + line.height, rect.y + rect.height)
      line.x = left
      line.y = top
      line.width = right - left
      line.height = bottom - top
    }
    if (merged.length === pending.length) {
      return merged.sort((left, right) => left.y - right.y || left.x - right.x)
    }
    pending = merged.sort((left, right) => left.y - right.y || left.x - right.x)
  }
}
