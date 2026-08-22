import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  addPdfBookmark,
  pdfBookmarkFingerprint,
  pdfBookmarksToOutline,
  removePdfBookmark,
  updatePdfBookmark,
} from '../src/client/pdf-bookmarks.ts'
import type { PdfBookmark } from '../src/client/pdf-bookmarks.ts'
import {
  loadPdfTextMarkupAnnotations,
  savePdfTextMarkupAnnotations,
} from '../src/client/pdf-annotation-save.ts'

const initial: readonly PdfBookmark[] = [
  { id: 'a', parentId: null, title: '第一章', pageNumber: 1 },
  { id: 'a-1', parentId: 'a', title: '第一节', pageNumber: 2 },
  { id: 'b', parentId: null, title: '第二章', pageNumber: 3 },
]

test('bookmark CRUD preserves preorder and moves or removes complete subtrees', () => {
  const added = addPdfBookmark(initial, {
    id: 'a-2', parentId: 'a', title: ' 第二节 ', pageNumber: 3,
  }, 4)
  assert.deepEqual(added.map(bookmark => bookmark.id), ['a', 'a-1', 'a-2', 'b'])
  assert.equal(added[2]?.title, '第二节')

  const moved = updatePdfBookmark(added, 'a', {
    parentId: 'b', title: '第一章（附录）', pageNumber: 1,
  }, 4)
  assert.deepEqual(moved.map(bookmark => [bookmark.id, bookmark.parentId]), [
    ['b', null], ['a', 'b'], ['a-1', 'a'], ['a-2', 'a'],
  ])
  assert.throws(() => updatePdfBookmark(moved, 'b', {
    parentId: 'a-1', title: 'cycle', pageNumber: 1,
  }, 4), /自己的子书签/)

  assert.deepEqual(removePdfBookmark(moved, 'a').map(bookmark => bookmark.id), ['b'])
})

test('bookmark fingerprints ignore generated ids but retain hierarchy and editor values', () => {
  const renamedIds: readonly PdfBookmark[] = [
    { ...initial[0]!, id: 'x' },
    { ...initial[1]!, id: 'y', parentId: 'x' },
    { ...initial[2]!, id: 'z' },
  ]
  assert.equal(pdfBookmarkFingerprint(initial), pdfBookmarkFingerprint(renamedIds))
  assert.notEqual(
    pdfBookmarkFingerprint(initial),
    pdfBookmarkFingerprint([{ ...initial[0]!, title: 'changed' }, ...initial.slice(1)]),
  )
})

test('bookmark projection exposes hierarchy and internal page destinations', () => {
  const projected = pdfBookmarksToOutline(initial)
  assert.deepEqual(projected.items.map(item => ({
    id: item.id, depth: item.depth, hasChildren: item.hasChildren, navigable: item.navigable,
  })), [
    { id: 'a', depth: 0, hasChildren: true, navigable: true },
    { id: 'a-1', depth: 1, hasChildren: false, navigable: true },
    { id: 'b', depth: 0, hasChildren: false, navigable: true },
  ])
  assert.deepEqual([...projected.pages], [['a', 1], ['a-1', 2], ['b', 3]])
})

test('standard PDF outlines round-trip with hierarchy, pages, links, and style', async () => {
  const document = await PDFDocument.create()
  document.addPage([100, 100])
  document.addPage([100, 100])
  document.addPage([100, 100])
  const source = await document.save()
  const bookmarks: readonly PdfBookmark[] = [
    { id: 'chapter', parentId: null, title: '章节', pageNumber: 1, bold: true },
    { id: 'section', parentId: 'chapter', title: '小节', pageNumber: 2, italic: true, color: [0.2, 0.4, 0.6] },
    { id: 'website', parentId: null, title: '参考链接', url: 'https://example.com/reference' },
  ]

  const saved = await savePdfTextMarkupAnnotations(source, [], { bookmarks })
  const restored = await loadPdfTextMarkupAnnotations(saved.bytes)
  assert.deepEqual(restored.bookmarks, bookmarks)
  const task = getDocument({ data: saved.bytes.slice() })
  const pdfjs = await task.promise
  try {
    const outline = await pdfjs.getOutline()
    assert.deepEqual(outline?.map(item => ({
      title: item.title,
      children: item.items.map(child => child.title),
      url: item.url,
    })), [
      { title: '章节', children: ['小节'], url: null },
      { title: '参考链接', children: [], url: 'https://example.com/reference' },
    ])
  } finally {
    await task.destroy()
  }

  const annotationOnlySave = await savePdfTextMarkupAnnotations(saved.bytes, [])
  assert.deepEqual(
    (await loadPdfTextMarkupAnnotations(annotationOnlySave.bytes)).bookmarks,
    bookmarks,
    'saving annotations alone must preserve an unchanged PDF outline',
  )

  const edited = updatePdfBookmark(restored.bookmarks, 'section', {
    parentId: null, title: '独立小节', pageNumber: 3,
  }, 3)
  const resaved = await savePdfTextMarkupAnnotations(saved.bytes, [], { bookmarks: edited })
  const reopened = await loadPdfTextMarkupAnnotations(resaved.bytes)
  assert.deepEqual(reopened.bookmarks, edited)

  const cleared = await savePdfTextMarkupAnnotations(resaved.bytes, [], { bookmarks: [] })
  assert.deepEqual((await loadPdfTextMarkupAnnotations(cleared.bytes)).bookmarks, [])
})

test('editing an uncommon bookmark retains its source action instead of silently dropping it', async () => {
  const document = await PDFDocument.create()
  document.addPage([100, 100])
  const root = document.context.obj({ Type: 'Outlines' })
  const rootRef = document.context.register(root)
  const item = document.context.obj({
    Title: PDFHexString.fromText('启动附件'),
    Parent: rootRef,
    A: { S: 'Launch', F: PDFString.of('appendix.pdf') },
  })
  const itemRef = document.context.register(item)
  root.set(PDFName.of('First'), itemRef)
  root.set(PDFName.of('Last'), itemRef)
  document.catalog.set(PDFName.of('Outlines'), rootRef)

  const source = await document.save()
  const restored = await loadPdfTextMarkupAnnotations(source)
  assert.equal(restored.bookmarks[0]?.preserveSourceAction, true)
  const edited = updatePdfBookmark(restored.bookmarks, restored.bookmarks[0]!.id, {
    parentId: null, title: '启动附录',
  }, 1)
  const saved = await savePdfTextMarkupAnnotations(source, [], { bookmarks: edited })
  const reopened = await PDFDocument.load(saved.bytes)
  const reopenedRoot = reopened.catalog.lookup(PDFName.of('Outlines'), PDFDict)
  const reopenedItem = reopenedRoot.lookup(PDFName.of('First'), PDFDict)
  const action = reopenedItem.lookup(PDFName.of('A'), PDFDict)
  assert.equal(action.lookup(PDFName.of('S'), PDFName).decodeText(), 'Launch')
  assert.equal(action.lookup(PDFName.of('F'), PDFString).decodeText(), 'appendix.pdf')
})
