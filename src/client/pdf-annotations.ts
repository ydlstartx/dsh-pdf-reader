import type { NormalizedPdfRect } from './pdf-rotation.ts'

export type PdfMarkupColor = 'yellow' | 'green' | 'blue' | 'pink'
export type PdfTextMarkupKind = 'highlight' | 'underline' | 'strikeout'
export type PdfMarkupStrokeWidth = 1 | 2 | 3

export interface PdfMarkupColorOption {
  id: PdfMarkupColor
  label: string
  /** Opaque toolbar swatch. */
  hex: string
  /** Translucent page overlay used while the source PDF is unchanged. */
  overlay: string
  /** Standard PDF RGB components reserved for the later save pipeline. */
  pdfRgb: readonly [number, number, number]
}

export const PDF_MARKUP_COLORS: readonly PdfMarkupColorOption[] = [
  { id: 'yellow', label: '黄色', hex: '#ffd84d', overlay: 'rgba(255, 216, 77, 0.48)', pdfRgb: [1, 0.847, 0.302] },
  { id: 'green', label: '绿色', hex: '#73d59a', overlay: 'rgba(115, 213, 154, 0.44)', pdfRgb: [0.451, 0.835, 0.604] },
  { id: 'blue', label: '蓝色', hex: '#79b8ff', overlay: 'rgba(121, 184, 255, 0.44)', pdfRgb: [0.475, 0.722, 1] },
  { id: 'pink', label: '粉色', hex: '#ff9eb5', overlay: 'rgba(255, 158, 181, 0.44)', pdfRgb: [1, 0.62, 0.71] },
]

export const MAX_PDF_ANNOTATION_NOTE_LENGTH = 2000

export function pdfTextMarkupKindLabel(kind: PdfTextMarkupKind): string {
  if (kind === 'underline') return '下划线'
  if (kind === 'strikeout') return '删除线'
  return '高亮'
}

/** One page-local member of a possibly cross-page text-markup group. */
export interface PdfTextMarkupAnnotation {
  id: string
  groupId: string
  kind: PdfTextMarkupKind
  pageNumber: number
  /** Canonical page coordinates at view rotation 0, independent of zoom. */
  rects: readonly NormalizedPdfRect[]
  /** The complete selected text for future notes, lists, and PDF contents. */
  text: string
  /** Optional user comment associated with the complete highlight group. */
  note: string
  color: PdfMarkupColor
  /** Text-line thickness in PDF user-space units; preview applies page scale. */
  strokeWidth: PdfMarkupStrokeWidth
}

export interface PdfTextMarkupGroup {
  groupId: string
  kind: PdfTextMarkupKind
  color: PdfMarkupColor
  pageNumbers: readonly number[]
  text: string
  note: string
  first: PdfTextMarkupAnnotation
}

export interface PdfTextMarkupDraft {
  pageNumber: number
  rects: readonly NormalizedPdfRect[]
  text: string
}

/** Collapse page-local annotation members into logical, page-ordered groups. */
export function groupPdfTextMarkupAnnotations(
  annotations: readonly PdfTextMarkupAnnotation[],
): readonly PdfTextMarkupGroup[] {
  const groups = new Map<string, PdfTextMarkupAnnotation[]>()
  for (const annotation of annotations) {
    const current = groups.get(annotation.groupId)
    if (current === undefined) groups.set(annotation.groupId, [annotation])
    else current.push(annotation)
  }
  return [...groups.entries()].map(([groupId, members]) => {
    const ordered = [...members].sort((left, right) => left.pageNumber - right.pageNumber)
    const first = ordered[0]!
    return {
      groupId,
      kind: first.kind,
      color: first.color,
      pageNumbers: [...new Set(ordered.map(annotation => annotation.pageNumber))],
      text: ordered.find(annotation => annotation.text.trim().length > 0)?.text.trim() ?? '',
      note: ordered.find(annotation => annotation.note.trim().length > 0)?.note.trim() ?? '',
      first,
    }
  }).sort((left, right) => (
    (left.pageNumbers[0] ?? 0) - (right.pageNumbers[0] ?? 0)
      || left.groupId.localeCompare(right.groupId)
  ))
}

export function pdfMarkupColorOption(color: PdfMarkupColor): PdfMarkupColorOption {
  return PDF_MARKUP_COLORS.find(option => option.id === color) ?? PDF_MARKUP_COLORS[0]!
}

/** Match the browser preview to the line width persisted in the PDF. */
export function pdfMarkupStrokeWidthCssPixels(
  strokeWidth: PdfMarkupStrokeWidth,
  pageScale: number,
): number {
  return strokeWidth * pageScale
}

/** Build a stable annotation group while rejecting empty page fragments. */
export function createPdfTextMarkupAnnotations(
  drafts: readonly PdfTextMarkupDraft[],
  kind: PdfTextMarkupKind,
  color: PdfMarkupColor,
  strokeWidth: PdfMarkupStrokeWidth,
  groupId: string,
): readonly PdfTextMarkupAnnotation[] {
  return drafts
    .filter(draft => draft.pageNumber >= 1 && draft.rects.length > 0)
    .map((draft, index) => ({
      id: `${groupId}:p${String(draft.pageNumber)}:${String(index + 1)}`,
      groupId,
      kind,
      pageNumber: draft.pageNumber,
      rects: draft.rects.map(rect => ({ ...rect })),
      text: draft.text,
      note: '',
      color,
      strokeWidth,
    }))
}

export function updatePdfTextMarkupGroupNote(
  annotations: readonly PdfTextMarkupAnnotation[],
  groupId: string,
  note: string,
): readonly PdfTextMarkupAnnotation[] {
  const bounded = note.trim().slice(0, MAX_PDF_ANNOTATION_NOTE_LENGTH)
  return annotations.map(annotation => annotation.groupId === groupId
    ? { ...annotation, note: bounded }
    : annotation)
}

export function updatePdfTextMarkupGroupColor(
  annotations: readonly PdfTextMarkupAnnotation[],
  groupId: string,
  color: PdfMarkupColor,
): readonly PdfTextMarkupAnnotation[] {
  return annotations.map(annotation => annotation.groupId === groupId
    ? { ...annotation, color }
    : annotation)
}

export function updatePdfTextMarkupGroupStrokeWidth(
  annotations: readonly PdfTextMarkupAnnotation[],
  groupId: string,
  strokeWidth: PdfMarkupStrokeWidth,
): readonly PdfTextMarkupAnnotation[] {
  return annotations.map(annotation => annotation.groupId === groupId
    ? { ...annotation, strokeWidth }
    : annotation)
}

export function removePdfTextMarkupGroup(
  annotations: readonly PdfTextMarkupAnnotation[],
  groupId: string,
): readonly PdfTextMarkupAnnotation[] {
  return annotations.filter(annotation => annotation.groupId !== groupId)
}
