import type { PdfTextMarkupAnnotation } from './pdf-annotations.ts'
import type { PdfBookmark } from './pdf-bookmarks.ts'
import type { PdfCitationBatch } from './pdf-citations.ts'
import type { PdfTextEvidence } from './pdf-evidence.ts'
import type { PdfPageRotation } from './pdf-rotation.ts'

const PDF_SESSION_DB_NAME = 'dsh-pdf-reader-sessions'
const PDF_SESSION_DB_VERSION = 2
const DOCUMENT_STORE = 'documents'
const DOCUMENT_ITEM_STORE = 'document-items'
const STATE_STORE = 'states'
const METADATA_STORE = 'metadata'

export const MAX_PDF_SESSION_RECORDS = 8
export const MAX_PDF_SESSION_CACHE_BYTES = 512 * 1024 * 1024

export interface PdfStoredSelection {
  pageNumber: number
  rect: { x: number; y: number; width: number; height: number }
  rotation: PdfPageRotation
  pngBase64: string
}

export interface PdfStoredEvidenceImage extends PdfStoredSelection {
  documentId: string
  documentName: string
}

export interface PdfSessionSharedEvidence {
  images: readonly PdfStoredEvidenceImage[]
  texts: readonly PdfTextEvidence[]
  selectedImageIndexes: readonly number[]
  selectedTextIds: readonly string[]
}

export interface PdfStoredReadingAnchor {
  pageNumber: number
  pageXRatio: number
  pageYRatio: number
}

export interface PdfViewerSessionState {
  zoom: number
  fitMode: 'width' | 'page'
  documentRotation: PdfPageRotation
  pageRotations: Readonly<Record<number, PdfPageRotation>>
  readingAnchor: PdfStoredReadingAnchor
  textEvidence: readonly PdfTextEvidence[]
  selectedEvidenceImageIndexes: readonly number[]
  selectedTextEvidenceIds: readonly string[]
}

export interface PdfSessionDocumentState {
  documentId: string
  /** Browser-known host index generation; probed before reuse after refresh. */
  indexId?: string
  annotations: readonly PdfTextMarkupAnnotation[]
  savedAnnotationFingerprint: string
  /** Optional for compatibility with version-2 records saved before bookmark editing. */
  bookmarks?: readonly PdfBookmark[]
  savedBookmarkFingerprint?: string
  evidenceImages: readonly PdfStoredSelection[]
  citationBatches: readonly PdfCitationBatch[]
  viewer?: PdfViewerSessionState
}

export interface PdfSessionState {
  version: 2
  readerOpen: boolean
  activeDocumentId: string
  documents: readonly PdfSessionDocumentState[]
  /** Conversation-level material that can combine sources from every open PDF. */
  sharedEvidence?: PdfSessionSharedEvidence
}

export interface PdfSessionDocument {
  documentId: string
  name: string
  bytes: ArrayBuffer
  updatedAt: number
}

export interface PdfSessionDocumentSummary {
  documentId: string
  name: string
  byteLength: number
  updatedAt: number
}

export interface PdfSessionRecord {
  activeDocumentId: string
  documents: readonly PdfSessionDocumentSummary[]
  state: PdfSessionState | undefined
}

interface StoredPdfSessionDocumentsV2 {
  version: 2
  sessionId: string
  activeDocumentId: string
  documents: readonly PdfSessionDocument[]
  updatedAt: number
}

interface StoredPdfSessionDocumentsV3 {
  version: 3
  sessionId: string
  activeDocumentId: string
  documents: readonly PdfSessionDocumentSummary[]
  updatedAt: number
}

interface StoredPdfSessionDocumentItem extends PdfSessionDocument {
  key: string
  sessionId: string
}

interface LegacyPdfSessionDocument {
  version: 1
  sessionId: string
  documentId?: string
  name: string
  bytes: ArrayBuffer
  updatedAt: number
}

interface LegacyPdfSessionState {
  version: 1
  readerOpen: boolean
  annotations: readonly PdfTextMarkupAnnotation[]
  savedAnnotationFingerprint: string
  evidenceImages: readonly PdfStoredSelection[]
  citationBatches: readonly PdfCitationBatch[]
  viewer: PdfViewerSessionState
}

export interface PdfSessionMetadata {
  sessionId: string
  updatedAt: number
  documentBytes: number
  stateBytes: number
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('PDF 会话存储请求失败')) }
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => { resolve() }
    transaction.onabort = () => { reject(transaction.error ?? new Error('PDF 会话存储事务已中止')) }
    transaction.onerror = () => { reject(transaction.error ?? new Error('PDF 会话存储事务失败')) }
  })
}

let databasePromise: Promise<IDBDatabase> | undefined

function database(): Promise<IDBDatabase> {
  if (databasePromise !== undefined) return databasePromise
  if (globalThis.indexedDB === undefined) return Promise.reject(new Error('当前浏览器不支持本地 PDF 会话恢复'))
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(PDF_SESSION_DB_NAME, PDF_SESSION_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(DOCUMENT_STORE)) db.createObjectStore(DOCUMENT_STORE, { keyPath: 'sessionId' })
      if (!db.objectStoreNames.contains(DOCUMENT_ITEM_STORE)) {
        const store = db.createObjectStore(DOCUMENT_ITEM_STORE, { keyPath: 'key' })
        store.createIndex('sessionId', 'sessionId', { unique: false })
      }
      if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE, { keyPath: 'sessionId' })
      if (!db.objectStoreNames.contains(METADATA_STORE)) db.createObjectStore(METADATA_STORE, { keyPath: 'sessionId' })
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => { db.close(); databasePromise = undefined }
      resolve(db)
    }
    request.onerror = () => {
      databasePromise = undefined
      reject(request.error ?? new Error('无法打开本地 PDF 会话存储'))
    }
    request.onblocked = () => {
      databasePromise = undefined
      reject(new Error('本地 PDF 会话存储正被其他页面占用'))
    }
  })
  return databasePromise
}

function estimatedStateBytes(state: PdfSessionState): number {
  // Avoid JSON.stringify(): a reusable image basket can otherwise create one
  // additional giant string immediately before IndexedDB performs its own
  // structured clone. This bounded walk estimates the same in-memory fields
  // without materializing another complete representation.
  let bytes = 0
  const pending: unknown[] = [state]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const value = pending.pop()
    if (value === null || value === undefined) continue
    if (typeof value === 'string') {
      bytes += value.length * 2
      continue
    }
    if (typeof value === 'number') {
      bytes += 8
      continue
    }
    if (typeof value === 'boolean') {
      bytes += 4
      continue
    }
    if (typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    if (value instanceof ArrayBuffer) {
      bytes += value.byteLength
      continue
    }
    if (ArrayBuffer.isView(value)) {
      bytes += value.byteLength
      continue
    }
    if (Array.isArray(value)) {
      bytes += value.length * 8
      pending.push(...value)
      continue
    }
    for (const [key, child] of Object.entries(value)) {
      bytes += key.length * 2
      pending.push(child)
    }
  }
  return bytes
}

export function pdfSessionCacheVictims(
  metadata: readonly PdfSessionMetadata[],
  currentSessionId: string,
  maxRecords = MAX_PDF_SESSION_RECORDS,
  maxBytes = MAX_PDF_SESSION_CACHE_BYTES,
): readonly string[] {
  const retained = [...metadata]
  const victims: string[] = []
  const totalBytes = (): number => retained.reduce(
    (total, item) => total + item.documentBytes + item.stateBytes,
    0,
  )
  retained.sort((left, right) => left.updatedAt - right.updatedAt)
  while (retained.length > maxRecords || totalBytes() > maxBytes) {
    const index = retained.findIndex(item => item.sessionId !== currentSessionId)
    if (index < 0) break
    victims.push(retained[index]!.sessionId)
    retained.splice(index, 1)
  }
  return victims
}

async function deleteSessions(sessionIds: readonly string[]): Promise<void> {
  if (sessionIds.length === 0) return
  const db = await database()
  const transaction = db.transaction([DOCUMENT_STORE, DOCUMENT_ITEM_STORE, STATE_STORE, METADATA_STORE], 'readwrite')
  const documents = transaction.objectStore(DOCUMENT_STORE)
  const documentItems = transaction.objectStore(DOCUMENT_ITEM_STORE)
  const states = transaction.objectStore(STATE_STORE)
  const metadata = transaction.objectStore(METADATA_STORE)
  for (const sessionId of sessionIds) {
    const cursorRequest = documentItems.index('sessionId').openKeyCursor(IDBKeyRange.only(sessionId))
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (cursor === null) return
      documentItems.delete(cursor.primaryKey)
      cursor.continue()
    }
    documents.delete(sessionId)
    states.delete(sessionId)
    metadata.delete(sessionId)
  }
  await transactionDone(transaction)
}

async function prune(currentSessionId: string): Promise<void> {
  const db = await database()
  const transaction = db.transaction(METADATA_STORE, 'readonly')
  const records = await requestResult(transaction.objectStore(METADATA_STORE).getAll()) as PdfSessionMetadata[]
  await transactionDone(transaction)
  await deleteSessions(pdfSessionCacheVictims(records, currentSessionId))
}

async function clearOtherSessions(currentSessionId: string): Promise<void> {
  const db = await database()
  const transaction = db.transaction(METADATA_STORE, 'readonly')
  const records = await requestResult(transaction.objectStore(METADATA_STORE).getAll()) as PdfSessionMetadata[]
  await transactionDone(transaction)
  await deleteSessions(records.filter(item => item.sessionId !== currentSessionId).map(item => item.sessionId))
}

function quotaFailure(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'QuotaExceededError'
}

async function withQuotaRetry(operation: () => Promise<void>, currentSessionId: string): Promise<void> {
  try {
    await operation()
  } catch (cause) {
    if (!quotaFailure(cause)) throw cause
    await clearOtherSessions(currentSessionId)
    await operation()
  }
  await prune(currentSessionId)
}

export async function savePdfSessionDocuments(
  sessionId: string,
  activeDocumentId: string,
  documents: readonly {
    documentId: string
    name: string
    byteLength?: number
    bytes?: ArrayBuffer
  }[],
): Promise<void> {
  const updatedAt = Date.now()
  await withQuotaRetry(async () => {
    const db = await database()
    const transaction = db.transaction([DOCUMENT_STORE, DOCUMENT_ITEM_STORE, METADATA_STORE], 'readwrite')
    const documentStore = transaction.objectStore(DOCUMENT_STORE)
    const itemStore = transaction.objectStore(DOCUMENT_ITEM_STORE)
    const metadataStore = transaction.objectStore(METADATA_STORE)
    const previousMetadata = await requestResult(metadataStore.get(sessionId)) as PdfSessionMetadata | undefined
    const nextIds = new Set(documents.map(document => document.documentId))
    // Enumerate only the small per-document records. Do not read the legacy
    // session blob again during migration: it may itself contain hundreds of
    // megabytes of PDF bytes.
    await new Promise<void>((resolve, reject) => {
      const cursorRequest = itemStore.index('sessionId').openCursor(IDBKeyRange.only(sessionId))
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (cursor === null) {
          resolve()
          return
        }
        const item = cursor.value as StoredPdfSessionDocumentItem
        if (!nextIds.has(item.documentId)) cursor.delete()
        cursor.continue()
      }
      cursorRequest.onerror = () => { reject(cursorRequest.error ?? new Error('无法更新 PDF 本地文档清单')) }
    })
    const retainedChecks = documents
      .filter(document => document.bytes === undefined)
      .map(async document => ({
        document,
        count: await requestResult(itemStore.count(documentItemKey(sessionId, document.documentId))),
      }))
    for (const check of await Promise.all(retainedChecks)) {
      if (check.count === 0) throw new Error(`缺少 PDF 本地字节：${check.document.name}`)
    }
    const summaries = documents.map(document => {
      const byteLength = document.bytes?.byteLength ?? document.byteLength
      if (byteLength === undefined) throw new Error(`缺少 PDF 本地字节：${document.name}`)
      if (document.bytes !== undefined) {
        itemStore.put({
          key: documentItemKey(sessionId, document.documentId),
          sessionId,
          documentId: document.documentId,
          name: document.name,
          bytes: document.bytes,
          updatedAt,
        } satisfies StoredPdfSessionDocumentItem)
      }
      return { documentId: document.documentId, name: document.name, byteLength, updatedAt }
    })
    const documentBytes = summaries.reduce((total, document) => total + document.byteLength, 0)
    documentStore.put({
      version: 3,
      sessionId,
      activeDocumentId,
      documents: summaries,
      updatedAt,
    } satisfies StoredPdfSessionDocumentsV3)
    metadataStore.put({
      sessionId,
      updatedAt,
      documentBytes,
      stateBytes: previousMetadata?.stateBytes ?? 0,
    } satisfies PdfSessionMetadata)
    await transactionDone(transaction)
  }, sessionId)
}

function documentItemKey(sessionId: string, documentId: string): string {
  return `${sessionId}\u0000${documentId}`
}

export async function savePdfSessionState(sessionId: string, state: PdfSessionState): Promise<void> {
  const updatedAt = Date.now()
  const stateBytes = estimatedStateBytes(state)
  await withQuotaRetry(async () => {
    const db = await database()
    const transaction = db.transaction([STATE_STORE, METADATA_STORE], 'readwrite')
    const metadataStore = transaction.objectStore(METADATA_STORE)
    const previous = await requestResult(metadataStore.get(sessionId)) as PdfSessionMetadata | undefined
    transaction.objectStore(STATE_STORE).put({ sessionId, state, updatedAt })
    metadataStore.put({
      sessionId,
      updatedAt,
      documentBytes: previous?.documentBytes ?? 0,
      stateBytes,
    } satisfies PdfSessionMetadata)
    await transactionDone(transaction)
  }, sessionId)
}

export async function loadPdfSession(sessionId: string): Promise<PdfSessionRecord | undefined> {
  const db = await database()
  const transaction = db.transaction([DOCUMENT_STORE, STATE_STORE], 'readonly')
  const [documentRecord, stateRecord] = await Promise.all([
    requestResult(transaction.objectStore(DOCUMENT_STORE).get(sessionId)) as Promise<StoredPdfSessionDocumentsV3 | StoredPdfSessionDocumentsV2 | LegacyPdfSessionDocument | undefined>,
    requestResult(transaction.objectStore(STATE_STORE).get(sessionId)) as Promise<{ sessionId: string; state: PdfSessionState | LegacyPdfSessionState } | undefined>,
  ])
  await transactionDone(transaction)
  if (documentRecord?.sessionId !== sessionId) return undefined
  if (documentRecord.version === 3) {
    const documents = documentRecord.documents.filter(document => document.byteLength > 0)
    if (documents.length === 0) return undefined
    const activeDocumentId = documents.some(document => document.documentId === documentRecord.activeDocumentId)
      ? documentRecord.activeDocumentId
      : documents[0]!.documentId
    const state = stateRecord?.sessionId === sessionId && stateRecord.state.version === 2
      ? stateRecord.state
      : undefined
    return { activeDocumentId, documents, state }
  }
  const migratedDocuments = documentRecord.version === 2
    ? documentRecord.documents.filter(document => document.bytes instanceof ArrayBuffer)
    : documentRecord.version === 1 && documentRecord.bytes instanceof ArrayBuffer
      ? [{
          documentId: documentRecord.documentId ?? '',
          name: documentRecord.name,
          bytes: documentRecord.bytes,
          updatedAt: documentRecord.updatedAt,
        }]
      : []
  if (migratedDocuments.length === 0) return undefined
  const requestedActiveDocumentId = documentRecord.version === 2
    ? documentRecord.activeDocumentId
    : documentRecord.documentId ?? ''
  const activeDocumentId = migratedDocuments.some(document => document.documentId === requestedActiveDocumentId)
    ? requestedActiveDocumentId
    : migratedDocuments[0]!.documentId
  const legacyState = stateRecord?.sessionId === sessionId && stateRecord.state.version === 1
    ? stateRecord.state
    : undefined
  const state = stateRecord?.sessionId === sessionId && stateRecord.state.version === 2
    ? stateRecord.state
    : legacyState === undefined ? undefined : {
      version: 2,
      readerOpen: legacyState.readerOpen,
      activeDocumentId,
      documents: [{
        documentId: activeDocumentId,
        annotations: legacyState.annotations,
        savedAnnotationFingerprint: legacyState.savedAnnotationFingerprint,
        evidenceImages: legacyState.evidenceImages,
        citationBatches: legacyState.citationBatches,
        viewer: legacyState.viewer,
      }],
    } satisfies PdfSessionState
  await savePdfSessionDocuments(sessionId, activeDocumentId, migratedDocuments)
  return {
    activeDocumentId,
    documents: migratedDocuments.map(document => ({
      documentId: document.documentId,
      name: document.name,
      byteLength: document.bytes.byteLength,
      updatedAt: document.updatedAt,
    })),
    state,
  }
}

/** Read one PDF body only when its tab or an explicit AI action needs it. */
export async function loadPdfSessionDocument(
  sessionId: string,
  documentId: string,
): Promise<PdfSessionDocument | undefined> {
  const db = await database()
  const transaction = db.transaction(DOCUMENT_ITEM_STORE, 'readonly')
  const item = await requestResult(transaction.objectStore(DOCUMENT_ITEM_STORE).get(documentItemKey(sessionId, documentId))) as StoredPdfSessionDocumentItem | undefined
  await transactionDone(transaction)
  if (item?.sessionId !== sessionId || item.documentId !== documentId || !(item.bytes instanceof ArrayBuffer)) return undefined
  return { documentId: item.documentId, name: item.name, bytes: item.bytes, updatedAt: item.updatedAt }
}

export async function deletePdfSession(sessionId: string): Promise<void> {
  await deleteSessions([sessionId])
}
