import assert from 'node:assert/strict'
import test from 'node:test'
import {
  effectivePdfPageRotation,
  normalizePdfRotation,
  rotateNormalizedPdfPoint,
  rotateNormalizedPdfRect,
  rotatePdfPageSize,
} from '../src/client/pdf-rotation.ts'

const closeTo = (actual: number, expected: number): void => {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${String(actual)} != ${String(expected)}`)
}

test('PDF view rotations normalize and compose without touching source bytes', () => {
  assert.equal(normalizePdfRotation(-90), 270)
  assert.equal(normalizePdfRotation(450), 90)
  assert.equal(effectivePdfPageRotation(270, 180), 90)
})

test('odd quarter turns swap page axes', () => {
  const portrait = { width: 600, height: 800 }
  assert.deepEqual(rotatePdfPageSize(portrait, 0), portrait)
  assert.deepEqual(rotatePdfPageSize(portrait, 90), { width: 800, height: 600 })
  assert.deepEqual(rotatePdfPageSize(portrait, 270), { width: 800, height: 600 })
})

test('normalized points retain their source location across view rotations', () => {
  const point = { x: 0.2, y: 0.3 }
  const clockwise = rotateNormalizedPdfPoint(point, 90)
  assert.deepEqual(clockwise, { x: 0.7, y: 0.2 })
  const restored = rotateNormalizedPdfPoint(clockwise, 270)
  closeTo(restored.x, point.x)
  closeTo(restored.y, point.y)
})

test('selection rectangles map between rotated page views', () => {
  const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }
  assert.deepEqual(rotateNormalizedPdfRect(rect, 90), {
    x: 0.4,
    y: 0.1,
    width: 0.4,
    height: 0.3,
  })
  const restored = rotateNormalizedPdfRect(rotateNormalizedPdfRect(rect, 90), 270)
  closeTo(restored.x, rect.x)
  closeTo(restored.y, rect.y)
  closeTo(restored.width, rect.width)
  closeTo(restored.height, rect.height)
})
