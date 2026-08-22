import assert from 'node:assert/strict'
import test from 'node:test'
import { computeWideGeometry } from '../src/client/geometry.ts'
import {
  base64ByteLength,
  constrainedPaintScale,
  fitWithinPixels,
} from '../src/client/render-constraints.ts'
import { MAX_CANVAS_DIMENSION } from '../src/limits.ts'
import { hasPdfHeader } from '../src/pdf-format.ts'

test('wide geometry preserves both minima when the viewport can fit them', () => {
  assert.deepEqual(computeWideGeometry(1440, 280, 0), {
    overlay: false,
    left: 280,
    panelWidth: 638,
  })
  assert.deepEqual(computeWideGeometry(800, 56, 999), {
    overlay: false,
    left: 56,
    panelWidth: 384,
  })
})

test('wide geometry uses a full viewport overlay when two panes cannot fit', () => {
  assert.deepEqual(computeWideGeometry(700, 56, 400), {
    overlay: true,
    left: 0,
    panelWidth: 700,
  })
})

test('paint scale caps the longest canvas edge', () => {
  const scale = constrainedPaintScale(600, 900, 8)
  assert.equal(scale, MAX_CANVAS_DIMENSION / 900)
  assert.ok(900 * scale <= MAX_CANVAS_DIMENSION)
})

test('selection raster dimensions stay within their pixel limit', () => {
  const fitted = fitWithinPixels(4000, 3000, 3_000_000)
  assert.ok(fitted.width * fitted.height <= 3_000_000)
})


test('PDF header validation accepts the spec prefix window only', () => {
  assert.equal(hasPdfHeader(Buffer.from('%PDF-1.7\n')), true)
  assert.equal(hasPdfHeader(Buffer.concat([Buffer.alloc(100), Buffer.from('%PDF-1.7')])), true)
  assert.equal(hasPdfHeader(Buffer.concat([Buffer.alloc(1024), Buffer.from('%PDF-1.7')])), false)
  assert.equal(hasPdfHeader(Buffer.from('not a pdf')), false)
})
