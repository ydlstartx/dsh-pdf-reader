import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PDF_IMAGE_ONLY_PROBE_PAGES,
  shouldStopAutomaticPdfIndex,
} from '../src/client/pdf-index-policy.ts'

test('automatic indexing stops after a bounded image-only probe', () => {
  assert.equal(shouldStopAutomaticPdfIndex({
    indexedPages: PDF_IMAGE_ONLY_PROBE_PAGES,
    totalPages: 1_248,
    codeUnits: 0,
  }), true)
  assert.equal(shouldStopAutomaticPdfIndex({
    indexedPages: PDF_IMAGE_ONLY_PROBE_PAGES - 1,
    totalPages: 1_248,
    codeUnits: 0,
  }), false)
})

test('native text keeps long-document idle indexing active', () => {
  assert.equal(shouldStopAutomaticPdfIndex({
    indexedPages: PDF_IMAGE_ONLY_PROBE_PAGES,
    totalPages: 1_248,
    codeUnits: 1,
  }), false)
  assert.equal(shouldStopAutomaticPdfIndex({
    indexedPages: PDF_IMAGE_ONLY_PROBE_PAGES,
    totalPages: PDF_IMAGE_ONLY_PROBE_PAGES,
    codeUnits: 0,
  }), false)
})
