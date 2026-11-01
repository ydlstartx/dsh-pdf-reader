import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'
import { loadPdfTextMarkupAnnotations } from '../src/client/pdf-annotation-save.ts'

/**
 * A name tree is not a dictionary: `/Dest (G5600.39200)` is answered by
 * walking `Names` arrays, and real manuals publish thousands of anchors. A
 * fixed scan window loses every chapter destination past it, which is exactly
 * how a book's outline went from clickable to inert.
 */
test('named destinations past a long name tree still resolve to a page', async () => {
  const document = await PDFDocument.create()
  document.addPage([100, 100])
  document.addPage([100, 100])
  document.addPage([100, 100])
  const pages = document.getPages()
  const firstPageDestination = document.context.register(document.context.obj([
    pages[0]!.ref, PDFName.of('Fit'),
  ]))
  const deepPageDestination = document.context.register(document.context.obj([
    pages[2]!.ref, PDFName.of('Fit'),
  ]))

  const entries: unknown[] = []
  for (let index = 0; index < 6_000; index += 1) {
    entries.push(PDFString.of(`G${String(index)}.${String(index * 7)}`))
    entries.push(index === 5_600 ? deepPageDestination : firstPageDestination)
  }
  // Two kids, so the walk has to descend rather than read one leaf.
  const left = document.context.obj({ Names: entries.slice(0, 8_000) })
  const right = document.context.obj({ Names: entries.slice(8_000) })
  const tree = document.context.obj({ Kids: [left, right] })
  document.catalog.set(PDFName.of('Names'), document.context.obj({ Dests: tree }))

  const root = document.context.obj({ Type: 'Outlines' })
  const rootRef = document.context.register(root)
  const item = document.context.obj({
    Title: PDFHexString.fromText('深层章节'),
    Parent: rootRef,
    Dest: PDFString.of('G5600.39200'),
  })
  const itemRef = document.context.register(item)
  root.set(PDFName.of('First'), itemRef)
  root.set(PDFName.of('Last'), itemRef)
  document.catalog.set(PDFName.of('Outlines'), rootRef)

  const restored = await loadPdfTextMarkupAnnotations(await document.save())
  assert.equal(restored.bookmarks.length, 1)
  assert.equal(restored.bookmarks[0]?.title, '深层章节')
  assert.equal(restored.bookmarks[0]?.pageNumber, 3)
  assert.equal(restored.bookmarks[0]?.preserveSourceAction, undefined)
})

test('an outline entry that only names a missing destination stays unresolved', async () => {
  const document = await PDFDocument.create()
  document.addPage([100, 100])
  const root = document.context.obj({ Type: 'Outlines' })
  const rootRef = document.context.register(root)
  const item = document.context.obj({
    Title: PDFHexString.fromText('悬空书签'),
    Parent: rootRef,
    Dest: PDFString.of('no-such-anchor'),
  })
  const itemRef = document.context.register(item)
  root.set(PDFName.of('First'), itemRef)
  root.set(PDFName.of('Last'), itemRef)
  document.catalog.set(PDFName.of('Outlines'), rootRef)

  const restored = await loadPdfTextMarkupAnnotations(await document.save())
  assert.equal(restored.bookmarks[0]?.pageNumber, undefined)
  assert.equal(restored.bookmarks[0]?.preserveSourceAction, true)
})

test('a producer that writes a page index instead of a page reference still navigates', async () => {
  const document = await PDFDocument.create()
  document.addPage([100, 100])
  document.addPage([100, 100])
  const root = document.context.obj({ Type: 'Outlines' })
  const rootRef = document.context.register(root)
  const item = document.context.obj({
    Title: PDFHexString.fromText('索引式目标'),
    Parent: rootRef,
    Dest: document.context.obj([1, PDFName.of('Fit')]),
  })
  const itemRef = document.context.register(item)
  root.set(PDFName.of('First'), itemRef)
  root.set(PDFName.of('Last'), itemRef)
  document.catalog.set(PDFName.of('Outlines'), rootRef)

  const restored = await loadPdfTextMarkupAnnotations(await document.save())
  assert.equal(restored.bookmarks[0]?.pageNumber, 2)
})
