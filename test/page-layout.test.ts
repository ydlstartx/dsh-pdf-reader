import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PDF_PAGE_GAP,
  PDF_STACK_BOTTOM_PADDING,
  pdfPageFitPageScale,
  pdfPageFitScale,
  pdfPageStackLayout,
  visiblePdfPageNumber,
} from '../src/client/pdf-page-layout.ts'

test('714-page geometry is numeric and preserves exact cumulative offsets', () => {
  const layout = pdfPageStackLayout(714, { width: 600, height: 800 }, {}, 0.5)

  assert.equal(layout.pages.length, 714)
  assert.equal(layout.width, 300)
  assert.deepEqual(layout.pages[0], { top: 0, left: 0, width: 300, height: 400 })
  assert.equal(layout.pages[713]?.top, 713 * (400 + PDF_PAGE_GAP))
  assert.equal(
    layout.height,
    714 * 400 + 713 * PDF_PAGE_GAP + PDF_STACK_BOTTOM_PADDING,
  )
})

test('measured page sizes update later offsets and center narrower pages', () => {
  const layout = pdfPageStackLayout(3, { width: 600, height: 800 }, {
    2: { width: 800, height: 1000 },
  }, 0.5)

  assert.deepEqual(layout.pages, [
    { top: 0, left: 50, width: 300, height: 400 },
    { top: 412, left: 0, width: 400, height: 500 },
    { top: 924, left: 50, width: 300, height: 400 },
  ])
})

test('fit width uses the widest measured page in a mixed-size document', () => {
  const cover = { width: 419.528, height: 595.276 }
  const body = { width: 539.998, height: 665.998 }
  const availableWidth = 1_000
  const scale = pdfPageFitScale(availableWidth, cover, { 2: body })
  const layout = pdfPageStackLayout(3, cover, { 2: body }, scale)

  assert.equal(scale, availableWidth / body.width)
  assert.equal(layout.width, availableWidth)
  assert.equal(layout.pages[1]?.width, availableWidth)
  assert.ok((layout.pages[0]?.left ?? 0) > 0)
})

test('view rotations update fit width and cumulative page geometry', () => {
  const portrait = { width: 600, height: 800 }
  const scale = pdfPageFitScale(800, portrait, {}, 0, { 2: 90 })
  const layout = pdfPageStackLayout(2, portrait, {}, scale, 0, { 2: 90 })

  assert.equal(scale, 1)
  assert.deepEqual(layout.pages, [
    { top: 0, left: 100, width: 600, height: 800 },
    { top: 812, left: 0, width: 800, height: 600 },
  ])
})

test('fit page uses both viewport axes and the largest rotated page', () => {
  const portrait = { width: 600, height: 800 }

  assert.equal(pdfPageFitPageScale(1_000, 700, portrait, {}), 700 / 800)
  assert.equal(pdfPageFitPageScale(500, 1_000, portrait, {}), 500 / 600)
  assert.equal(
    pdfPageFitPageScale(900, 700, portrait, { 2: { width: 400, height: 1_000 } }, 0, { 3: 90 }),
    700 / 1_000,
  )
})

test('visible-page lookup is logarithmic before inspecting the visible window', () => {
  const layout = pdfPageStackLayout(714, { width: 600, height: 800 }, {}, 1)
  const page500 = layout.pages[499]

  assert.ok(page500)
  assert.equal(visiblePdfPageNumber(layout.pages, page500.top + 100, 500), 500)
  assert.equal(visiblePdfPageNumber([], 0, 500), undefined)
})

test('equal visible shares keep the earlier page', () => {
  const layout = pdfPageStackLayout(2, { width: 600, height: 800 }, {}, 1)
  const viewportTop = 700
  const viewportHeight = 2 * 100 + PDF_PAGE_GAP

  assert.equal(visiblePdfPageNumber(layout.pages, viewportTop, viewportHeight), 1)
})
