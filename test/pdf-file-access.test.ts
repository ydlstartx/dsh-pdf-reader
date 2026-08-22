import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPdfFileUnchanged,
  pdfFileIdentity,
  writePdfFile,
} from '../src/client/pdf-file-access.ts'
import type { PdfFileHandle, PdfWritableStream } from '../src/client/pdf-file-access.ts'

function fakeHandle(initial: File): {
  handle: PdfFileHandle
  writes: Uint8Array[]
  replaceExternally: (file: File) => void
} {
  let current = initial
  const writes: Uint8Array[] = []
  const handle: PdfFileHandle = {
    kind: 'file',
    name: initial.name,
    getFile: async () => current,
    createWritable: async (): Promise<PdfWritableStream> => ({
      write: async (bytes) => { writes.push(bytes.slice()) },
      close: async () => {
        const bytes = writes.at(-1) ?? new Uint8Array()
        current = new File([bytes], initial.name, {
          type: 'application/pdf',
          lastModified: initial.lastModified + 1,
        })
      },
    }),
  }
  return { handle, writes, replaceExternally: file => { current = file } }
}

test('file-handle writes close before exposing the updated file identity', async () => {
  const initial = new File(['old'], 'paper.pdf', { type: 'application/pdf', lastModified: 10 })
  const fake = fakeHandle(initial)
  const saved = await writePdfFile(fake.handle, new Uint8Array([1, 2, 3, 4]))

  assert.deepEqual([...fake.writes[0]!], [1, 2, 3, 4])
  assert.equal(saved.size, 4)
  assert.equal(saved.lastModified, 11)
})

test('overwrite detects an external source change before creating a writer', async () => {
  const initial = new File(['old'], 'paper.pdf', { type: 'application/pdf', lastModified: 10 })
  const fake = fakeHandle(initial)
  const identity = pdfFileIdentity(initial)
  await assert.doesNotReject(assertPdfFileUnchanged(fake.handle, identity))

  fake.replaceExternally(new File(['external'], 'paper.pdf', {
    type: 'application/pdf', lastModified: 20,
  }))
  await assert.rejects(assertPdfFileUnchanged(fake.handle, identity), /其他程序修改/)
  assert.equal(fake.writes.length, 0)
})
