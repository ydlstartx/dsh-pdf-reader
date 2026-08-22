/** Browser-local user preferences for one explicitly authorized OCR question. */

import {
  PDF_OCR_DEFAULT_PAGE_BUDGET,
  PDF_OCR_DEFAULT_PAGES_PER_BATCH,
  PDF_OCR_DEFAULT_VISUAL_BUDGET,
} from '../pdf-ocr.ts'

export const PDF_OCR_PREFERENCES_STORAGE_KEY = 'dsh-pdf-reader:ocr-preferences:v1'

export interface PdfOcrPreferences {
  maxOcrPages: number
  maxVisualPages: number
  maxPagesPerBatch: number
}

export const DEFAULT_PDF_OCR_PREFERENCES: PdfOcrPreferences = {
  maxOcrPages: PDF_OCR_DEFAULT_PAGE_BUDGET,
  maxVisualPages: PDF_OCR_DEFAULT_VISUAL_BUDGET,
  maxPagesPerBatch: PDF_OCR_DEFAULT_PAGES_PER_BATCH,
}

function validInteger(value: unknown, minimum: number, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
    ? value
    : fallback
}

export function normalizePdfOcrPreferences(value: unknown): PdfOcrPreferences {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    maxOcrPages: validInteger(record.maxOcrPages, 1, PDF_OCR_DEFAULT_PAGE_BUDGET),
    maxVisualPages: validInteger(record.maxVisualPages, 0, PDF_OCR_DEFAULT_VISUAL_BUDGET),
    maxPagesPerBatch: validInteger(record.maxPagesPerBatch, 1, PDF_OCR_DEFAULT_PAGES_PER_BATCH),
  }
}

export function loadPdfOcrPreferences(storage: Pick<Storage, 'getItem'>): PdfOcrPreferences {
  try {
    const raw = storage.getItem(PDF_OCR_PREFERENCES_STORAGE_KEY)
    return raw === null ? { ...DEFAULT_PDF_OCR_PREFERENCES } : normalizePdfOcrPreferences(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_PDF_OCR_PREFERENCES }
  }
}

export function savePdfOcrPreferences(
  storage: Pick<Storage, 'setItem'>,
  preferences: PdfOcrPreferences,
): void {
  try {
    storage.setItem(PDF_OCR_PREFERENCES_STORAGE_KEY, JSON.stringify(normalizePdfOcrPreferences(preferences)))
  } catch {
    // Private browsing or a full quota must not block the current question.
  }
}
