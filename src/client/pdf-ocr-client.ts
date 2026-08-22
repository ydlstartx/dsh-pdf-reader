/** Browser-local OCR relay. No model or OCR asset loads before an authorized request arrives. */

import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { OcrResult } from '@paddleocr/paddleocr-js'
import {
  PDF_OCR_MAX_PAGE_IMAGE_BYTES,
  PDF_OCR_RENDER_LONG_EDGE,
  PDF_OCR_ROUTE,
} from '../pdf-ocr.ts'
import type {
  PdfOcrClientRequest,
  PdfOcrLine,
  PdfOcrPageResultRequest,
  PdfOcrPollResponse,
  PdfOcrRequestBase,
} from '../pdf-ocr.ts'

const OCR_CACHE_DATABASE = 'dsh-pdf-reader-ocr-v1'
const OCR_CACHE_STORE = 'pages'
const OCR_CACHE_ENGINE = 'paddleocr-js-0.4.2-pp-ocrv5-ch'
const OCR_ENGINE_IDLE_DISPOSE_MS = 30_000
export const MAX_PDF_OCR_CACHE_PAGES = 512
export const MAX_PDF_OCR_CACHE_BYTES = 64 * 1024 * 1024

interface CachedPdfOcrPage {
  key: string
  fingerprint: string
  pageNumber: number
  width: number
  height: number
  lines: readonly PdfOcrLine[]
  /** Optional for records written before bounded LRU metadata was introduced. */
  updatedAt?: number
  estimatedBytes?: number
}

export interface PdfOcrCacheEntryMetadata {
  key: string
  updatedAt: number
  bytes: number
}

/** Oldest entries leave first until both persistent-cache bounds are satisfied. */
export function pdfOcrCacheVictims(
  metadata: readonly PdfOcrCacheEntryMetadata[],
  maxPages = MAX_PDF_OCR_CACHE_PAGES,
  maxBytes = MAX_PDF_OCR_CACHE_BYTES,
): readonly string[] {
  const entryBytes = (value: number): number => (
    Number.isFinite(value) && value > 0 ? value : 0
  )
  const retained = [...metadata].sort((left, right) => (
    left.updatedAt - right.updatedAt || left.key.localeCompare(right.key)
  ))
  let bytes = retained.reduce((total, entry) => total + entryBytes(entry.bytes), 0)
  const victims: string[] = []
  while (retained.length > maxPages || bytes > maxBytes) {
    const victim = retained.shift()
    if (victim === undefined) break
    victims.push(victim.key)
    bytes -= entryBytes(victim.bytes)
  }
  return victims
}

function estimatedOcrCachePageBytes(page: CachedPdfOcrPage): number {
  const keyLength = typeof page.key === 'string' ? page.key.length : 0
  const fingerprintLength = typeof page.fingerprint === 'string' ? page.fingerprint.length : 0
  let bytes = 256 + (keyLength + fingerprintLength) * 2
  const lines = Array.isArray(page.lines) ? page.lines : []
  for (const line of lines) {
    const textLength = typeof line?.text === 'string' ? line.text.length : 0
    const polygonLength = Array.isArray(line?.polygon) ? line.polygon.length : 0
    bytes += 64 + textLength * 2 + polygonLength * 16
  }
  return bytes
}

interface OcrEngine {
  predict(input: unknown): Promise<OcrResult[]>
  dispose(): Promise<void>
}

let sharedOcrEngine: OcrEngine | undefined
let sharedOcrEnginePromise: Promise<OcrEngine> | undefined
let sharedOcrEngineIdleTimer: number | undefined
let sharedOcrPredictionQueue: Promise<void> = Promise.resolve()
let sharedOcrJobQueue: Promise<void> = Promise.resolve()

function cacheKey(fingerprint: string, pageNumber: number): string {
  return `${OCR_CACHE_ENGINE}:${fingerprint}:${String(pageNumber)}`
}

/** Keep manifests isolated from cache entries created by older OCR engines. */
function cacheFingerprint(fingerprint: string): string {
  return `${OCR_CACHE_ENGINE}:${fingerprint}`
}

function openOcrCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OCR_CACHE_DATABASE, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(OCR_CACHE_STORE)) {
        const store = database.createObjectStore(OCR_CACHE_STORE, { keyPath: 'key' })
        store.createIndex('fingerprint', 'fingerprint', { unique: false })
      }
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('无法打开 PDF OCR 缓存')) }
  })
}

async function cachedOcrPage(fingerprint: string, pageNumber: number): Promise<CachedPdfOcrPage | undefined> {
  const database = await openOcrCache()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(OCR_CACHE_STORE, 'readwrite')
      const store = transaction.objectStore(OCR_CACHE_STORE)
      const request = store.get(cacheKey(fingerprint, pageNumber))
      let result: CachedPdfOcrPage | undefined
      request.onsuccess = () => {
        const current = request.result as CachedPdfOcrPage | undefined
        if (current === undefined) return
        result = {
          ...current,
          updatedAt: Date.now(),
          estimatedBytes: estimatedOcrCachePageBytes(current),
        }
        store.put(result)
      }
      transaction.oncomplete = () => { resolve(result) }
      transaction.onerror = () => { reject(transaction.error ?? new Error('无法读取 PDF OCR 缓存')) }
      transaction.onabort = () => { reject(transaction.error ?? new Error('PDF OCR 缓存读取已中止')) }
    })
  } finally {
    database.close()
  }
}

async function pruneOcrCache(): Promise<void> {
  const database = await openOcrCache()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OCR_CACHE_STORE, 'readwrite')
      const store = transaction.objectStore(OCR_CACHE_STORE)
      const metadata: PdfOcrCacheEntryMetadata[] = []
      const request = store.openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor === null) {
          for (const key of pdfOcrCacheVictims(metadata)) store.delete(key)
          return
        }
        const value = cursor.value as CachedPdfOcrPage
        if (typeof value.key === 'string' && Array.isArray(value.lines)) {
          metadata.push({
            key: value.key,
            updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
              ? value.updatedAt
              : 0,
            bytes: estimatedOcrCachePageBytes(value),
          })
        } else {
          cursor.delete()
        }
        cursor.continue()
      }
      request.onerror = () => { reject(request.error ?? new Error('无法清理 PDF OCR 缓存')) }
      transaction.oncomplete = () => { resolve() }
      transaction.onerror = () => { reject(transaction.error ?? new Error('无法清理 PDF OCR 缓存')) }
      transaction.onabort = () => { reject(transaction.error ?? new Error('PDF OCR 缓存清理已中止')) }
    })
  } finally {
    database.close()
  }
}

async function cacheOcrPage(page: CachedPdfOcrPage): Promise<void> {
  const database = await openOcrCache()
  try {
    const stored = {
      ...page,
      updatedAt: Date.now(),
      estimatedBytes: estimatedOcrCachePageBytes(page),
    }
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OCR_CACHE_STORE, 'readwrite')
      transaction.objectStore(OCR_CACHE_STORE).put(stored)
      transaction.oncomplete = () => { resolve() }
      transaction.onerror = () => { reject(transaction.error ?? new Error('无法写入 PDF OCR 缓存')) }
      transaction.onabort = () => { reject(transaction.error ?? new Error('PDF OCR 缓存写入已中止')) }
    })
  } finally {
    database.close()
  }
  await pruneOcrCache()
}

async function cachedOcrPages(fingerprint: string, totalPages: number): Promise<readonly number[]> {
  const database = await openOcrCache()
  try {
    return await new Promise((resolve, reject) => {
      const pages: number[] = []
      const index = database.transaction(OCR_CACHE_STORE, 'readonly')
        .objectStore(OCR_CACHE_STORE).index('fingerprint')
      const request = index.openCursor(IDBKeyRange.only(cacheFingerprint(fingerprint)))
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor === null) {
          resolve([...new Set(pages)].sort((left, right) => left - right))
          return
        }
        const value = cursor.value as CachedPdfOcrPage
        if (value.pageNumber >= 1 && value.pageNumber <= totalPages) pages.push(value.pageNumber)
        cursor.continue()
      }
      request.onerror = () => { reject(request.error ?? new Error('无法枚举 PDF OCR 缓存')) }
    })
  } finally {
    database.close()
  }
}

async function postOcr<T>(request: PdfOcrClientRequest, signal?: AbortSignal): Promise<T> {
  const response = await fetch(PDF_OCR_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    credentials: 'same-origin',
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    let detail = ''
    try {
      const value = await response.json() as { error?: unknown }
      if (typeof value.error === 'string') detail = `：${value.error}`
    } catch {
      // Preserve the HTTP status when a proxy returns non-JSON.
    }
    throw new Error(`PDF OCR 通道不可用（HTTP ${String(response.status)}）${detail}`)
  }
  return await response.json() as T
}

export async function grantPdfOcrAccess(
  base: PdfOcrRequestBase,
  grant: {
    grantId: string
    currentPage: number
    maxOcrPages: number
    maxVisualPages: number
    maxPagesPerBatch: number
  },
): Promise<void> {
  await postOcr({ action: 'grant', ...base, ...grant })
}

export async function revokePdfOcrAccess(base: PdfOcrRequestBase, grantId: string): Promise<void> {
  await postOcr({ action: 'revoke', ...base, grantId })
}

async function renderPage(doc: PDFDocumentProxy, pageNumber: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber)
  try {
    const natural = page.getViewport({ scale: 1 })
    const scale = Math.max(0.5, Math.min(2.5, PDF_OCR_RENDER_LONG_EDGE / Math.max(natural.width, natural.height)))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    const context = canvas.getContext('2d', { alpha: false })
    if (context === null) throw new Error('浏览器无法创建 OCR 页面画布')
    context.save()
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.restore()
    await page.render({ canvas, canvasContext: context, viewport }).promise
    return canvas
  } finally {
    page.cleanup()
  }
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('无法编码 OCR 页面图像'))
      else resolve(blob)
    }, 'image/jpeg', quality)
  })
}

async function boundedJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  let working = canvas
  for (let attempt = 0; attempt < 5; attempt += 1) {
    for (const quality of [0.82, 0.7, 0.58]) {
      const blob = await canvasBlob(working, quality)
      if (blob.size <= PDF_OCR_MAX_PAGE_IMAGE_BYTES) {
        if (working !== canvas) {
          working.width = 1
          working.height = 1
        }
        return blob
      }
    }
    const reduced = document.createElement('canvas')
    reduced.width = Math.max(1, Math.round(working.width * 0.8))
    reduced.height = Math.max(1, Math.round(working.height * 0.8))
    const context = reduced.getContext('2d', { alpha: false })
    if (context === null) break
    context.drawImage(working, 0, 0, reduced.width, reduced.height)
    if (working !== canvas) {
      working.width = 1
      working.height = 1
    }
    working = reduced
  }
  throw new Error(`页面图像超过 ${String(PDF_OCR_MAX_PAGE_IMAGE_BYTES)} 字节视觉预算`)
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : ''
      const comma = value.indexOf(',')
      if (comma < 0) reject(new Error('页面图像编码格式无效'))
      else resolve(value.slice(comma + 1))
    }
    reader.onerror = () => { reject(reader.error ?? new Error('无法读取页面图像')) }
    reader.readAsDataURL(blob)
  })
}

async function createOcrEngine(): Promise<OcrEngine> {
  // Harness's client module loader intentionally has no relative chunk
  // resolver. Keep this URL computed so the reader's single-file bundle stays
  // intact; the host serves the heavyweight OCR runtime only after permission.
  const runtimeUrl = '/plugins/dsh-pdf-reader/ocr-assets/ocr-runtime.js'
  const runtime = await import(/* @vite-ignore */ runtimeUrl) as {
    createPdfOcrEngine: () => Promise<OcrEngine>
  }
  return await runtime.createPdfOcrEngine()
}

async function acquireSharedOcrEngine(): Promise<OcrEngine> {
  if (sharedOcrEngineIdleTimer !== undefined) {
    window.clearTimeout(sharedOcrEngineIdleTimer)
    sharedOcrEngineIdleTimer = undefined
  }
  if (sharedOcrEngine !== undefined) return sharedOcrEngine
  if (sharedOcrEnginePromise === undefined) {
    sharedOcrEnginePromise = createOcrEngine().then((engine) => {
      sharedOcrEngine = engine
      return engine
    }).catch((cause: unknown) => {
      sharedOcrEnginePromise = undefined
      throw cause
    })
  }
  return await sharedOcrEnginePromise
}

function scheduleSharedOcrEngineDisposal(): void {
  if (sharedOcrEngineIdleTimer !== undefined) window.clearTimeout(sharedOcrEngineIdleTimer)
  sharedOcrEngineIdleTimer = window.setTimeout(() => {
    sharedOcrEngineIdleTimer = undefined
    const engine = sharedOcrEngine
    sharedOcrEngine = undefined
    sharedOcrEnginePromise = undefined
    void engine?.dispose().catch(() => {})
  }, OCR_ENGINE_IDLE_DISPOSE_MS)
}

/** Reuse one heavyweight OCR runtime; predictions are serialized for safety. */
async function predictWithSharedOcrEngine(input: unknown): Promise<OcrResult[]> {
  const result = sharedOcrPredictionQueue.then(async () => {
    const engine = await acquireSharedOcrEngine()
    try {
      return await engine.predict(input)
    } finally {
      scheduleSharedOcrEngineDisposal()
    }
  })
  sharedOcrPredictionQueue = result.then(() => {}, () => {})
  return await result
}

async function runSerializedOcrJob<T>(job: () => Promise<T>): Promise<T> {
  const result = sharedOcrJobQueue.then(job)
  sharedOcrJobQueue = result.then(() => {}, () => {})
  return await result
}

function normalizedLines(
  items: readonly OcrResult['items'][number][],
  width: number,
  height: number,
): readonly PdfOcrLine[] {
  return items.flatMap((item) => {
    const text = item.text.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 2_000)
    if (text.length === 0 || !Number.isFinite(item.score)) return []
    const polygon = item.poly.slice(0, 8).map(point => ({
      x: Math.max(0, Math.min(1, point[0] / Math.max(1, width))),
      y: Math.max(0, Math.min(1, point[1] / Math.max(1, height))),
    }))
    if (polygon.length < 4) return []
    return [{ text, score: Math.max(0, Math.min(1, item.score)), polygon }]
  }).slice(0, 4_000)
}

export interface PdfOcrRelayOptions extends PdfOcrRequestBase {
  /** Load the PDF only after the model requests an authorized page. */
  getDocument: () => Promise<PDFDocumentProxy>
  /** Release a relay-owned pdf.js document when the grant ends. */
  releaseDocument?: (doc: PDFDocumentProxy) => Promise<void> | void
  signal: AbortSignal
  onStatus?: (status: string | undefined) => void
}

/** Poll only after authorization; the potentially large PDF stays unloaded until a page is requested. */
export async function runPdfOcrRelay(options: PdfOcrRelayOptions): Promise<void> {
  const base: PdfOcrRequestBase = {
    sessionId: options.sessionId,
    documentId: options.documentId,
    indexId: options.indexId,
  }
  let doc: PDFDocumentProxy | undefined
  let fingerprint: string | undefined
  let cacheManifestPublished = false
  const ensureDocument = async (): Promise<PDFDocumentProxy> => {
    if (doc !== undefined) return doc
    doc = await options.getDocument()
    fingerprint = doc.fingerprints[0] ?? options.documentId
    if (!cacheManifestPublished) {
      try {
        const pages = await cachedOcrPages(fingerprint, doc.numPages)
        await postOcr({ action: 'cache-manifest', ...base, pages }, options.signal)
        cacheManifestPublished = true
      } catch (error) {
        if (options.signal.aborted) throw error
        // Cache discovery is optional; OCR can still proceed and recreate entries.
        console.warn('dsh-pdf-reader: unable to publish OCR cache manifest', error)
      }
    }
    return doc
  }
  const releaseDocument = async (): Promise<void> => {
    const loaded = doc
    doc = undefined
    if (loaded !== undefined) await options.releaseDocument?.(loaded)
  }
  try {
    while (!options.signal.aborted) {
      const pending = await postOcr<PdfOcrPollResponse>({ action: 'poll', ...base }, options.signal)
      if (pending.requestId === undefined || pending.grantId === undefined || pending.pages.length === 0) {
        await new Promise<void>((resolve) => { window.setTimeout(resolve, 800) })
        continue
      }
      const requestId = pending.requestId
      const grantId = pending.grantId
      try {
        await runSerializedOcrJob(async () => {
          if (options.signal.aborted) return
          const activeDocument = await ensureDocument()
          const activeFingerprint = fingerprint ?? options.documentId
          for (const pageNumber of pending.pages) {
            if (options.signal.aborted) return
            options.onStatus?.(`AI 已获授权，正在识别第 ${String(pageNumber)} 页…`)
            const cached = await cachedOcrPage(activeFingerprint, pageNumber)
            const fromCache = cached !== undefined
            let result: CachedPdfOcrPage
            let canvas: HTMLCanvasElement | undefined
            let durationMs = 0
            try {
              if (cached !== undefined) {
                result = cached
              } else {
                canvas = await renderPage(activeDocument, pageNumber)
                if (sharedOcrEngine === undefined && sharedOcrEnginePromise === undefined) {
                  options.onStatus?.('首次 OCR：正在加载本地识别模型…')
                }
                const startedAt = performance.now()
                const [recognized] = await predictWithSharedOcrEngine(canvas)
                if (recognized === undefined) throw new Error(`第 ${String(pageNumber)} 页没有 OCR 返回结果`)
                result = {
                  key: cacheKey(activeFingerprint, pageNumber),
                  fingerprint: cacheFingerprint(activeFingerprint),
                  pageNumber,
                  width: recognized.image.width,
                  height: recognized.image.height,
                  lines: normalizedLines(recognized.items, recognized.image.width, recognized.image.height),
                }
                await cacheOcrPage(result)
                durationMs = Math.max(0, Math.round(performance.now() - startedAt))
              }
              if (pending.visualPages.includes(pageNumber) && canvas === undefined) {
                canvas = await renderPage(activeDocument, pageNumber)
              }
              const response: PdfOcrPageResultRequest = {
                action: 'result',
                ...base,
                requestId,
                grantId,
                pageNumber,
                width: result.width,
                height: result.height,
                lines: result.lines,
                durationMs,
                fromCache,
                ...(pending.visualPages.includes(pageNumber) && canvas !== undefined
                  ? { jpegBase64: await blobBase64(await boundedJpeg(canvas)) }
                  : {}),
              }
              await postOcr(response, options.signal)
            } finally {
              if (canvas !== undefined) {
                canvas.width = 1
                canvas.height = 1
              }
            }
          }
        })
      } catch (error) {
        if (options.signal.aborted) return
        await postOcr({
          action: 'error',
          ...base,
          requestId,
          grantId,
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
      } finally {
        await releaseDocument().catch(() => {})
        options.onStatus?.(undefined)
      }
    }
  } finally {
    await releaseDocument()
  }
}
