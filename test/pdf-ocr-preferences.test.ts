import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PDF_OCR_PREFERENCES,
  loadPdfOcrPreferences,
  normalizePdfOcrPreferences,
  PDF_OCR_PREFERENCES_STORAGE_KEY,
  savePdfOcrPreferences,
} from '../src/client/pdf-ocr-preferences.ts'

test('OCR preferences default to 20 new pages, 2 visuals, and 4 pages per batch', () => {
  assert.deepEqual(normalizePdfOcrPreferences(undefined), DEFAULT_PDF_OCR_PREFERENCES)
  assert.deepEqual(loadPdfOcrPreferences({ getItem: () => null }), DEFAULT_PDF_OCR_PREFERENCES)
})

test('OCR preferences preserve arbitrarily raised safe integers and reject invalid values', () => {
  assert.deepEqual(normalizePdfOcrPreferences({
    maxOcrPages: 5_000,
    maxVisualPages: 600,
    maxPagesPerBatch: 800,
  }), {
    maxOcrPages: 5_000,
    maxVisualPages: 600,
    maxPagesPerBatch: 800,
  })
  assert.deepEqual(normalizePdfOcrPreferences({
    maxOcrPages: Number.MAX_SAFE_INTEGER + 1,
    maxVisualPages: -1,
    maxPagesPerBatch: 0,
  }), DEFAULT_PDF_OCR_PREFERENCES)
})

test('OCR preferences persist under a dedicated browser key', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  savePdfOcrPreferences(storage, { maxOcrPages: 12, maxVisualPages: 0, maxPagesPerBatch: 3 })
  assert.equal(values.has(PDF_OCR_PREFERENCES_STORAGE_KEY), true)
  assert.deepEqual(loadPdfOcrPreferences(storage), {
    maxOcrPages: 12,
    maxVisualPages: 0,
    maxPagesPerBatch: 3,
  })
})
