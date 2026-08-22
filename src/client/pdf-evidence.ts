/** Ephemeral native-text material collected for one PDF multimodal request. */

import {
  MAX_PDF_MIXED_TEXTS,
  MAX_PDF_MIXED_TEXT_CODE_UNITS,
} from './composer-pdf-mixed.ts'
import { MAX_PDF_TEXT_REFERENCE_CODE_UNITS } from './composer-pdf-reference.ts'
import type { PdfTextReference } from './composer-pdf-reference.ts'
import type { PdfTextMarkupDraft } from './pdf-annotations.ts'
import { base64ByteLength } from './render-constraints.ts'

/** Keep reusable screenshots useful without allowing an unbounded Base64 heap. */
export const MAX_PDF_EVIDENCE_IMAGES = 20
export const MAX_PDF_EVIDENCE_IMAGE_BYTES = 24 * 1024 * 1024

export interface PdfEvidenceImageData {
  pngBase64: string
}

export interface PdfTextEvidence {
  id: string
  documentId: string
  documentName: string
  text: string
  drafts: readonly PdfTextMarkupDraft[]
}

export interface AddPdfTextEvidenceResult {
  sources: readonly PdfTextEvidence[]
  added: boolean
}

/** Add one screenshot while bounding both item count and decoded payload. */
export function addPdfEvidenceImage<T extends PdfEvidenceImageData>(
  current: readonly T[],
  candidate: T,
  maxImages = MAX_PDF_EVIDENCE_IMAGES,
  maxBytes = MAX_PDF_EVIDENCE_IMAGE_BYTES,
): readonly T[] {
  if (current.length >= maxImages) {
    throw new Error(`图片资料过多（最多 ${String(maxImages)} 张）`)
  }
  const totalBytes = current.reduce((total, image) => total + base64ByteLength(image.pngBase64), 0)
    + base64ByteLength(candidate.pngBase64)
  if (totalBytes > maxBytes) {
    throw new Error(`图片资料总量过大（最多 ${String(Math.floor(maxBytes / 1024 / 1024))} MiB），请删除部分图片后重试`)
  }
  return [...current, candidate]
}

/** Safely restore older baskets that predate the in-memory image boundary. */
export function boundedPdfEvidenceImages<T extends PdfEvidenceImageData>(
  images: readonly T[],
  maxImages = MAX_PDF_EVIDENCE_IMAGES,
  maxBytes = MAX_PDF_EVIDENCE_IMAGE_BYTES,
): readonly T[] {
  const bounded: T[] = []
  let totalBytes = 0
  for (const image of images) {
    if (bounded.length >= maxImages) break
    const bytes = base64ByteLength(image.pngBase64)
    if (bytes <= 0 || totalBytes + bytes > maxBytes) continue
    bounded.push(image)
    totalBytes += bytes
  }
  return bounded
}

/** Keep explicit exclusions while selecting newly added material by default. */
export function reconcilePdfEvidenceSelection<T>(
  selected: readonly T[],
  previouslyKnown: ReadonlySet<T>,
  available: readonly T[],
): readonly T[] {
  const selectedSet = new Set(selected)
  return available.filter(item => selectedSet.has(item) || !previouslyKnown.has(item))
}

function normalizedEvidenceText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (normalized.length === 0) throw new Error('没有可加入资料的 PDF 文字')
  if (normalized.length > MAX_PDF_TEXT_REFERENCE_CODE_UNITS) {
    throw new Error(`选中文字过长（最多 ${String(MAX_PDF_TEXT_REFERENCE_CODE_UNITS)} 个字符）`)
  }
  return normalized
}

function normalizedEvidencePages(drafts: readonly PdfTextMarkupDraft[]): number[] {
  const pages = [...new Set(drafts.map(draft => draft.pageNumber))]
    .filter(page => Number.isSafeInteger(page) && page > 0)
    .sort((left, right) => left - right)
  if (pages.length === 0) throw new Error('文字资料缺少有效 PDF 页码')
  return pages
}

/** Geometry-aware key: repeated words in different page locations remain distinct. */
export function pdfTextEvidenceKey(source: Pick<PdfTextEvidence, 'documentId' | 'text' | 'drafts'>): string {
  const text = normalizedEvidenceText(source.text)
  normalizedEvidencePages(source.drafts)
  return JSON.stringify({
    documentId: source.documentId,
    text,
    drafts: source.drafts.map(draft => ({ pageNumber: draft.pageNumber, rects: draft.rects })),
  })
}

/** Add one explicit selection, rejecting overflow and ignoring exact duplicates. */
export function addPdfTextEvidence(
  current: readonly PdfTextEvidence[],
  candidate: PdfTextEvidence,
): AddPdfTextEvidenceResult {
  const key = pdfTextEvidenceKey(candidate)
  if (current.some(source => pdfTextEvidenceKey(source) === key)) {
    return { sources: current, added: false }
  }
  if (current.length >= MAX_PDF_MIXED_TEXTS) {
    throw new Error(`文字资料过多（最多 ${String(MAX_PDF_MIXED_TEXTS)} 段）`)
  }
  const text = normalizedEvidenceText(candidate.text)
  const total = current.reduce((sum, source) => sum + normalizedEvidenceText(source.text).length, 0) + text.length
  if (total > MAX_PDF_MIXED_TEXT_CODE_UNITS) {
    throw new Error(`文字资料总量过大（最多 ${String(MAX_PDF_MIXED_TEXT_CODE_UNITS)} 个字符）`)
  }
  return { sources: [...current, { ...candidate, text }], added: true }
}

/** Safely restore legacy text baskets without trusting their serialized size. */
export function boundedPdfTextEvidence(
  sources: readonly PdfTextEvidence[],
): readonly PdfTextEvidence[] {
  let bounded: readonly PdfTextEvidence[] = []
  for (const source of sources) {
    if (bounded.length >= MAX_PDF_MIXED_TEXTS) break
    try {
      bounded = addPdfTextEvidence(bounded, source).sources
    } catch {
      // Skip one corrupt or oversized legacy entry and keep scanning later ones.
    }
  }
  return bounded
}

export function pdfTextEvidenceReference(source: PdfTextEvidence): PdfTextReference {
  return {
    documentName: source.documentName,
    pageNumbers: normalizedEvidencePages(source.drafts),
    text: normalizedEvidenceText(source.text),
  }
}

/** Combine stored material with one live selection while preserving geometry. */
export function pdfTextEvidenceSources(
  stored: readonly PdfTextEvidence[],
  live?: Pick<PdfTextEvidence, 'documentId' | 'documentName' | 'text' | 'drafts'>,
): readonly PdfTextEvidence[] {
  if (live === undefined) return stored
  return stored.some(source => pdfTextEvidenceKey(source) === pdfTextEvidenceKey(live))
    ? stored
    : [...stored, { ...live, id: 'live' }]
}

/** Combine stored material with the live selection without duplicating it. */
export function pdfTextEvidenceReferences(
  stored: readonly PdfTextEvidence[],
  live?: Pick<PdfTextEvidence, 'documentId' | 'documentName' | 'text' | 'drafts'>,
): readonly PdfTextReference[] {
  return pdfTextEvidenceSources(stored, live).map(pdfTextEvidenceReference)
}
