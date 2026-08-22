/** Browser file-handle boundary for explicit PDF open, Save As, and overwrite actions. */

export interface PdfWritableStream {
  write: (data: Uint8Array) => Promise<void>
  close: () => Promise<void>
  abort?: (reason?: unknown) => Promise<void>
}

export interface PdfFileHandle {
  readonly kind: 'file'
  readonly name: string
  getFile: () => Promise<File>
  createWritable: () => Promise<PdfWritableStream>
}

interface PdfPickerHost {
  showOpenFilePicker?: (options: unknown) => Promise<readonly PdfFileHandle[]>
  showSaveFilePicker?: (options: unknown) => Promise<PdfFileHandle>
}

export interface PdfFileIdentity {
  size: number
  lastModified: number
}

export interface PickedPdfFile {
  file: File
  handle: PdfFileHandle
}

export function pdfFileIdentity(file: File): PdfFileIdentity {
  return { size: file.size, lastModified: file.lastModified }
}

export function supportsNativePdfOpen(host: Window): boolean {
  return typeof (host as unknown as PdfPickerHost).showOpenFilePicker === 'function'
}

export function supportsNativePdfSaveAs(host: Window): boolean {
  return typeof (host as unknown as PdfPickerHost).showSaveFilePicker === 'function'
}

export function isPdfPickerCancellation(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError'
}

/** Open a PDF with a write-capable handle; returns undefined for user cancellation. */
export async function pickPdfFile(host: Window): Promise<PickedPdfFile | undefined> {
  const picker = (host as unknown as PdfPickerHost).showOpenFilePicker
  if (picker === undefined) return undefined
  try {
    const handles = await picker({
      multiple: false,
      excludeAcceptAllOption: false,
      types: [{
        description: 'PDF 文档',
        accept: { 'application/pdf': ['.pdf'] },
      }],
    })
    const handle = handles[0]
    if (handle === undefined) return undefined
    return { handle, file: await handle.getFile() }
  } catch (cause) {
    if (isPdfPickerCancellation(cause)) return undefined
    throw cause
  }
}

/** Refuse a blind overwrite when the file changed after it was opened or last saved. */
export async function assertPdfFileUnchanged(
  handle: PdfFileHandle,
  expected: PdfFileIdentity,
): Promise<void> {
  const current = await handle.getFile()
  if (current.size !== expected.size || current.lastModified !== expected.lastModified) {
    throw new Error('原 PDF 自打开或上次保存后已被其他程序修改，请重新打开后再覆盖')
  }
}

/** Write and close atomically according to the browser handle's implementation. */
export async function writePdfFile(handle: PdfFileHandle, bytes: Uint8Array): Promise<File> {
  const writable = await handle.createWritable()
  try {
    await writable.write(bytes)
    await writable.close()
  } catch (cause) {
    try {
      await writable.abort?.(cause)
    } catch {
      // Preserve the primary write failure.
    }
    throw cause
  }
  return handle.getFile()
}

/**
 * Acquire a native Save As handle; call this synchronously from the click
 * chain so Chromium's transient user activation is still available.
 */
export async function pickPdfSaveHandle(
  host: Window,
  suggestedName: string,
): Promise<PdfFileHandle | undefined> {
  const picker = (host as unknown as PdfPickerHost).showSaveFilePicker
  if (picker === undefined) return undefined
  try {
    return await picker({
      suggestedName,
      excludeAcceptAllOption: false,
      types: [{
        description: 'PDF 文档',
        accept: { 'application/pdf': ['.pdf'] },
      }],
    })
  } catch (cause) {
    if (isPdfPickerCancellation(cause)) return undefined
    throw cause
  }
}

/** Download fallback for browsers without the File System Access save picker. */
export function downloadPdfBytes(bytes: Uint8Array, filename: string): void {
  // Copy into a concrete ArrayBuffer: typed arrays may legally be backed by
  // SharedArrayBuffer, while BlobPart intentionally accepts ArrayBuffer only.
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const blob = new Blob([buffer], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}
