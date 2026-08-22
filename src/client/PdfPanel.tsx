/**
 * dsh-pdf-reader browser half: the session-scoped reader controller.
 *
 * Owns the browser file-picker intake, the reader-window lifecycle, and the
 * main-composer attachment boundary. Selected files never leave the browser
 * as raw PDF bytes.
 * @module dsh-pdf-reader/client/PdfPanel
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { MAX_OPEN_PDF_BYTES, MAX_PDF_BYTES } from '../limits.ts'
import { hasPdfHeader } from '../pdf-format.ts'
import { PdfViewer } from './PdfViewer.tsx'
import type { PdfEvidenceImage, SelectionInfo } from './PdfViewer.tsx'
import {
  createPdfTextMarkupAnnotations,
  removePdfTextMarkupGroup,
  updatePdfTextMarkupGroupColor,
  updatePdfTextMarkupGroupNote,
  updatePdfTextMarkupGroupStrokeWidth,
} from './pdf-annotations.ts'
import type {
  PdfMarkupColor,
  PdfMarkupStrokeWidth,
  PdfTextMarkupAnnotation,
  PdfTextMarkupDraft,
  PdfTextMarkupGroup,
  PdfTextMarkupKind,
} from './pdf-annotations.ts'
import { releaseConsumedComposerSelections } from './composer-selection.ts'
import type { ComposerImageLimits, ComposerSelectionHandle } from './composer-selection.ts'
import type {
  PdfAiAction,
  PdfAiRequest,
  PdfAnnotationAiAction,
  PdfAnnotationAiRequest,
  PdfDocumentsAiRequest,
  PdfTextReference,
} from './composer-pdf-reference.ts'
import type { PdfImageAiAction, PdfImageAiRequest } from './composer-pdf-image.ts'
import type { PdfMixedAiAction, PdfMixedAiRequest } from './composer-pdf-mixed.ts'
import {
  appendPdfCitationBatch,
  resolvePdfCitation,
} from './pdf-citations.ts'
import type {
  PdfCitationBatch,
  PdfCitationReference,
  PdfCitationTarget,
} from './pdf-citations.ts'
import {
  addPdfEvidenceImage,
  boundedPdfEvidenceImages,
  boundedPdfTextEvidence,
  pdfTextEvidenceReference,
  reconcilePdfEvidenceSelection,
} from './pdf-evidence.ts'
import type { PdfTextEvidence } from './pdf-evidence.ts'
import type { PdfOutlineController } from './pdf-outline.ts'
import { loadPdfTextMarkupAnnotations, savePdfTextMarkupAnnotations } from './pdf-annotation-save.ts'
import {
  addPdfBookmark,
  pdfBookmarkFingerprint,
  removePdfBookmark,
  updatePdfBookmark,
} from './pdf-bookmarks.ts'
import type { PdfBookmark } from './pdf-bookmarks.ts'
import {
  assertPdfFileUnchanged,
  downloadPdfBytes,
  pdfFileIdentity,
  pickPdfFile,
  pickPdfSaveHandle,
  supportsNativePdfOpen,
  supportsNativePdfSaveAs,
  writePdfFile,
} from './pdf-file-access.ts'
import type { PdfFileHandle, PdfFileIdentity } from './pdf-file-access.ts'
import {
  deletePdfSession,
  loadPdfSession,
  loadPdfSessionDocument,
  savePdfSessionDocuments,
  savePdfSessionState,
} from './pdf-session-store.ts'
import type {
  PdfSessionDocumentState,
  PdfSessionState,
  PdfViewerSessionState,
} from './pdf-session-store.ts'
import { createPdfDocumentId, syncPdfDocumentIndex } from './pdf-document-index-sync.ts'
import { validPdfDocumentId } from '../pdf-document-index.ts'
import { PDF_OCR_GRANT_TTL_MS } from '../pdf-ocr.ts'
import {
  grantPdfOcrAccess,
  revokePdfOcrAccess,
  runPdfOcrRelay,
} from './pdf-ocr-client.ts'
import type { PdfOcrPreferences } from './pdf-ocr-preferences.ts'
import { loadPdfDocument } from './pdfjs.ts'
import { buildBackgroundPdfDocumentIndex } from './pdf-background-index.ts'

/** One picker-selected document: bytes plus display metadata. */
export interface LoadedPdf {
  id: number
  /** Random generation key used to reject stale tool citations after replacement. */
  documentId: string
  name: string
  size: number
  bytes: ArrayBuffer
  /** Render copy without plugin-owned annotations; editable overlays paint them instead. */
  viewBytes: ArrayBuffer
  /** Present only when the browser granted direct write access. */
  handle?: PdfFileHandle
  /** Last observed handle state, used to reject blind overwrites. */
  sourceIdentity?: PdfFileIdentity
}

/** Panel props handed down from the plugin apply closure. */
export interface PdfPanelProps {
  /** Close the details column (the layout's panel action). */
  onClose: () => void
  /** The session this panel renders for (framework-injected standard prop). */
  sessionId: SessionId
  /** Host-projected attachment bounds for the selection screenshot. */
  imageLimits: ComposerImageLimits | undefined
  /** Attach one crop to the current session's main conversation composer. */
  attachSelectionFor: (
    sessionId: SessionId,
    file: File,
    limits: ComposerImageLimits | undefined,
  ) => ComposerSelectionHandle
  /** Append source-labelled PDF text to the current editable draft. */
  appendTextReferenceFor: (sessionId: SessionId, reference: PdfTextReference) => void
  /** Send one user-confirmed immutable document scope through the conversation. */
  sendDocumentsQuestionFor: (sessionId: SessionId, request: PdfDocumentsAiRequest) => Promise<void>
  /** Queue an explicit AI reading action in the current Harness conversation. */
  sendTextAiRequestFor: (sessionId: SessionId, request: PdfAiRequest) => Promise<void>
  /** Queue one AI turn over the current filtered annotation groups. */
  sendAnnotationAiRequestFor: (sessionId: SessionId, request: PdfAnnotationAiRequest) => Promise<void>
  /** Queue an explicit image-region AI action without consuming the composer draft. */
  sendImageAiRequestFor: (sessionId: SessionId, images: readonly File[], request: PdfImageAiRequest) => Promise<void>
  /** Queue one image-region + native-text AI turn without consuming the composer draft. */
  sendMixedAiRequestFor: (sessionId: SessionId, images: readonly File[], request: PdfMixedAiRequest) => Promise<void>
  /** Wide-mode lifecycle: close the details column on enter (exit keeps it closed). */
  onWideChange: (open: boolean) => void
  /**
   * Subscribe to the floating PDF button's open requests. The panel answers
   * by opening the reader window, or by popping the file picker when no
   * document is loaded. Returns the unsubscriber.
   */
  onOpenRequest: (listener: () => void) => () => void
  /** Subscribe to source links emitted in settled AI answers. */
  onCitationRequest: (listener: (reference: PdfCitationReference) => boolean) => () => void
  /** Publish this session's live outline controller to the root sidebar. */
  onOutlineChange: (sessionId: SessionId, outline: PdfOutlineController | undefined) => void
  /** Toggle the root PDF search surface; returns whether it is open. */
  onSearchToggle: () => boolean
}

function fileTooLargeMessage(size: number): string {
  return `PDF 过大（${String(size)} 字节，上限 ${String(MAX_PDF_BYTES)} 字节）`
}

function annotationFingerprint(annotations: readonly PdfTextMarkupAnnotation[]): string {
  return JSON.stringify(annotations)
}

function annotatedPdfName(name: string): string {
  const stem = name.replace(/\.pdf$/iu, '') || 'document'
  return `${stem}-annotated.pdf`
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function retainedOutputBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : copiedArrayBuffer(bytes)
}

/** Reuse immutable source bytes when annotation loading did not rewrite them. */
function retainedViewBuffer(source: ArrayBuffer, viewBytes: Uint8Array): ArrayBuffer {
  return viewBytes.buffer === source
    && viewBytes.byteOffset === 0
    && viewBytes.byteLength === source.byteLength
    ? source
    : copiedArrayBuffer(viewBytes)
}

function openPdfBytes(runtimes: ReadonlyMap<string, PdfDocumentRuntime>): number {
  let total = 0
  for (const runtime of runtimes.values()) total += runtime.document.size
  return total
}

function restoredAnnotationSequence(annotations: readonly PdfTextMarkupAnnotation[]): number {
  return annotations.reduce((highest, annotation) => {
    const match = /^markup-(\d+)$/u.exec(annotation.groupId)
    return Math.max(highest, match === null ? 0 : Number(match[1]))
  }, 0)
}

/** Decode the bounded crop into the browser File expected by the composer. */
function selectionFile(pdfName: string, selection: SelectionInfo, sequence: number): File {
  const binary = atob(selection.pngBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const stem = pdfName.replace(/\.pdf$/i, '')
  return new File(
    [bytes],
    `${stem}-p${String(selection.pageNumber)}-selection-${String(sequence)}.png`,
    { type: 'image/png' },
  )
}

interface ComposerSelectionRecord {
  documentId: string
  selection: SelectionInfo
  handle: ComposerSelectionHandle
  unsubscribe: () => void
}

const PDF_SESSION_SAVE_DELAY_MS = 400

interface PdfDocumentRuntime {
  /** Lightweight tab metadata retained even while its PDF body is evicted. */
  document: Pick<LoadedPdf, 'id' | 'documentId' | 'name' | 'size'>
  loaded: LoadedPdf | undefined
  /** False only for an inactive restored tab whose render copy is still lazy. */
  viewPrepared: boolean
  viewPreparation?: Promise<void>
  /** Legacy records without editor state restore annotations during lazy prepare. */
  restoreAnnotationsOnPrepare: boolean
  /** Legacy records without bookmark state restore the PDF outline lazily. */
  restoreBookmarksOnPrepare: boolean
  /** Restored documents can reload their raw bytes from this conversation. */
  storedSessionId?: string
  /** Only changed/new PDF bodies need another IndexedDB structured clone. */
  needsDocumentPersistence: boolean
  annotations: readonly PdfTextMarkupAnnotation[]
  savedAnnotationFingerprint: string
  bookmarks: readonly PdfBookmark[]
  savedBookmarkFingerprint: string
  viewer: PdfViewerSessionState | undefined
  citationBatches: readonly PdfCitationBatch[]
  composerSelections: ComposerSelectionRecord[]
  selectionSequence: number
  annotationSequence: number
  citationSequence: number
  indexId?: string
}

interface ActivePdfOcrScope {
  grantId: string
  abort: AbortController
  expireTimer: number
  bases: readonly { sessionId: string; documentId: string; indexId: string }[]
}

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    height: '100%',
    padding: '12px',
    boxSizing: 'border-box',
    fontSize: '13px',
    color: 'var(--dsw-alias-content-secondary, #555)',
    overflowY: 'auto',
  } as const,
  title: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-content-primary, #222)' } as const,
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } as const,
  closeButton: {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-content-tertiary, #999)',
    cursor: 'pointer',
    fontSize: '14px',
    padding: '2px 6px',
    borderRadius: '6px',
  } as const,
  row: { display: 'flex', gap: '8px' } as const,
  input: {
    flex: 1,
    minWidth: 0,
    padding: '6px 8px',
    borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-primary, #ccc)',
    background: 'var(--dsw-alias-bg-primary, #fff)',
    color: 'inherit',
    fontSize: '12px',
  } as const,
  button: {
    padding: '6px 12px',
    borderRadius: '8px',
    border: 'none',
    background: 'var(--dsw-alias-bg-brand, #4d6bfe)',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '12px',
    whiteSpace: 'nowrap',
  } as const,
  error: { color: '#d4380d', whiteSpace: 'pre-wrap' } as const,
  intake: { display: 'flex', flexDirection: 'column', gap: '12px' } as const,
} satisfies Record<string, import('react').CSSProperties>

/** Session-scoped reader controller hosted by the details seat. */
export function PdfPanel(props: PdfPanelProps) {
  const [loaded, setLoaded] = useState<LoadedPdf | undefined>(undefined)
  const [documentTabs, setDocumentTabs] = useState<readonly string[]>([])
  const [activeDocumentId, setActiveDocumentId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const [readerOpen, setReaderOpen] = useState(false)
  /** Crops still mirrored into the normal Harness composer. */
  const [selections, setSelections] = useState<readonly SelectionInfo[]>([])
  /** Crops explicitly moved into the PDF-only multimodal evidence basket. */
  const [evidenceImages, setEvidenceImages] = useState<readonly PdfEvidenceImage[]>([])
  const [textEvidence, setTextEvidence] = useState<readonly PdfTextEvidence[]>([])
  const [selectedEvidenceImages, setSelectedEvidenceImages] = useState<readonly PdfEvidenceImage[]>([])
  const [selectedTextEvidenceIds, setSelectedTextEvidenceIds] = useState<ReadonlySet<string>>(new Set())
  const [annotations, setAnnotations] = useState<readonly PdfTextMarkupAnnotation[]>([])
  const [savedAnnotationFingerprint, setSavedAnnotationFingerprint] = useState(annotationFingerprint([]))
  const [bookmarks, setBookmarks] = useState<readonly PdfBookmark[]>([])
  const [savedBookmarkFingerprint, setSavedBookmarkFingerprint] = useState(pdfBookmarkFingerprint([]))
  const [saveBusy, setSaveBusy] = useState<'save-as' | 'overwrite' | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [persistenceError, setPersistenceError] = useState<string | undefined>(undefined)
  const [initialViewerSessionState, setInitialViewerSessionState] = useState<PdfViewerSessionState | undefined>(undefined)
  const documentIdRef = useRef(0)
  const loadSequenceRef = useRef(0)
  const activationSequenceRef = useRef(0)
  const selectionSequenceRef = useRef(0)
  const annotationSequenceRef = useRef(0)
  const composerSelectionsRef = useRef<ComposerSelectionRecord[]>([])
  const documentRuntimesRef = useRef(new Map<string, PdfDocumentRuntime>())
  const activeDocumentIdRef = useRef<string | undefined>(undefined)
  const evidenceImagesRef = useRef<readonly PdfEvidenceImage[]>([])
  const citationSequenceRef = useRef(0)
  const citationBatchesRef = useRef<readonly PdfCitationBatch[]>([])
  const citationNavigationSequenceRef = useRef(0)
  const [citationNavigation, setCitationNavigation] = useState<{ target: PdfCitationTarget; revision: number } | undefined>(undefined)
  const viewerSessionStateRef = useRef<PdfViewerSessionState | undefined>(undefined)
  /** One divider width belongs to the conversation, not to an individual PDF tab. */
  const readerWideWidthRef = useRef(0)
  const activeOcrScopeRef = useRef<ActivePdfOcrScope | undefined>(undefined)
  const indexPreparationAbortRef = useRef<AbortController | undefined>(undefined)
  const activeSessionIdRef = useRef(props.sessionId)
  activeSessionIdRef.current = props.sessionId
  const onWideChangeRef = useRef(props.onWideChange)
  onWideChangeRef.current = props.onWideChange
  const persistenceEnabledRef = useRef(false)
  const persistenceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingStateSaveRef = useRef<{ sessionId: SessionId; state: PdfSessionState } | undefined>(undefined)
  const stateSaveDrainQueuedRef = useRef(false)
  const pendingDocumentsSaveRef = useRef<{
    sessionId: SessionId
    activeDocumentId: string
    documents: readonly {
      documentId: string
      name: string
      byteLength: number
      bytes?: ArrayBuffer
    }[]
    pendingBodies: readonly { runtime: PdfDocumentRuntime; bytes: ArrayBuffer }[]
  } | undefined>(undefined)
  const documentsSaveDrainQueuedRef = useRef(false)
  const [documentsPersistenceRevision, setDocumentsPersistenceRevision] = useState(0)
  const panelSnapshotRef = useRef({
    loaded,
    readerOpen,
    annotations,
    savedAnnotationFingerprint,
    bookmarks,
    savedBookmarkFingerprint,
  })
  panelSnapshotRef.current = {
    loaded,
    readerOpen,
    annotations,
    savedAnnotationFingerprint,
    bookmarks,
    savedBookmarkFingerprint,
  }
  const sharedEvidenceSnapshotRef = useRef({
    textEvidence,
    selectedEvidenceImages,
    selectedTextEvidenceIds,
  })
  sharedEvidenceSnapshotRef.current = {
    textEvidence,
    selectedEvidenceImages,
    selectedTextEvidenceIds,
  }

  const revokeActiveOcrScope = useCallback(async (): Promise<void> => {
    const scope = activeOcrScopeRef.current
    if (scope === undefined) return
    activeOcrScopeRef.current = undefined
    window.clearTimeout(scope.expireTimer)
    scope.abort.abort()
    await Promise.all(scope.bases.map(async base => {
      await revokePdfOcrAccess(base, scope.grantId).catch(() => {})
    }))
  }, [])

  const abortIndexPreparation = useCallback((): void => {
    indexPreparationAbortRef.current?.abort()
    indexPreparationAbortRef.current = undefined
  }, [])

  useEffect(() => () => {
    abortIndexPreparation()
    void revokeActiveOcrScope()
  }, [abortIndexPreparation, props.sessionId, revokeActiveOcrScope])

  const captureActiveRuntime = useCallback((): void => {
    const documentId = activeDocumentIdRef.current
    if (documentId === undefined) return
    const runtime = documentRuntimesRef.current.get(documentId)
    const snapshot = panelSnapshotRef.current
    if (runtime === undefined || snapshot.loaded?.documentId !== documentId) return
    runtime.loaded = snapshot.loaded
    runtime.document = {
      id: snapshot.loaded.id,
      documentId: snapshot.loaded.documentId,
      name: snapshot.loaded.name,
      size: snapshot.loaded.size,
    }
    runtime.annotations = snapshot.annotations
    runtime.savedAnnotationFingerprint = snapshot.savedAnnotationFingerprint
    runtime.bookmarks = snapshot.bookmarks
    runtime.savedBookmarkFingerprint = snapshot.savedBookmarkFingerprint
    runtime.viewer = viewerSessionStateRef.current
    runtime.citationBatches = citationBatchesRef.current
    runtime.composerSelections = composerSelectionsRef.current
    runtime.selectionSequence = selectionSequenceRef.current
    runtime.annotationSequence = annotationSequenceRef.current
    runtime.citationSequence = citationSequenceRef.current
  }, [])

  const activatePreparedRuntime = useCallback((documentId: string): boolean => {
    const runtime = documentRuntimesRef.current.get(documentId)
    if (runtime?.loaded === undefined || !runtime.viewPrepared) return false
    activeDocumentIdRef.current = documentId
    setActiveDocumentId(documentId)
    composerSelectionsRef.current = runtime.composerSelections
    citationBatchesRef.current = runtime.citationBatches
    viewerSessionStateRef.current = runtime.viewer
    selectionSequenceRef.current = runtime.selectionSequence
    annotationSequenceRef.current = runtime.annotationSequence
    citationSequenceRef.current = runtime.citationSequence
    setLoaded(runtime.loaded)
    setSelections(runtime.composerSelections.map(record => record.selection))
    setAnnotations(runtime.annotations)
    setSavedAnnotationFingerprint(runtime.savedAnnotationFingerprint)
    setBookmarks(runtime.bookmarks)
    setSavedBookmarkFingerprint(runtime.savedBookmarkFingerprint)
    setInitialViewerSessionState(runtime.viewer)
    setSaveBusy(undefined)
    setSaveError(undefined)
    setCitationNavigation(undefined)
    return true
  }, [])

  const prepareRuntime = useCallback(async (runtime: PdfDocumentRuntime): Promise<LoadedPdf> => {
    if (runtime.loaded !== undefined && runtime.viewPrepared) return runtime.loaded
    if (runtime.viewPreparation === undefined) {
      runtime.viewPreparation = (async () => {
        let document = runtime.loaded
        if (document === undefined) {
          if (runtime.storedSessionId === undefined) throw new Error('PDF 原文件已经释放且没有可恢复副本')
          const stored = await loadPdfSessionDocument(runtime.storedSessionId, runtime.document.documentId)
          if (stored === undefined) throw new Error(`找不到“${runtime.document.name}”的本地恢复副本`)
          if (stored.bytes.byteLength > MAX_PDF_BYTES) throw new Error(fileTooLargeMessage(stored.bytes.byteLength))
          if (!hasPdfHeader(stored.bytes)) throw new Error(`本地恢复副本不是有效 PDF: ${runtime.document.name}`)
          document = {
            ...runtime.document,
            size: stored.bytes.byteLength,
            bytes: stored.bytes,
            viewBytes: stored.bytes,
          }
          runtime.document = {
            id: document.id,
            documentId: document.documentId,
            name: document.name,
            size: document.size,
          }
          runtime.loaded = document
        }
        const source = document.bytes
        const restored = await loadPdfTextMarkupAnnotations(source)
        if (documentRuntimesRef.current.get(document.documentId) !== runtime || runtime.loaded === undefined) return
        runtime.loaded = {
          ...runtime.loaded,
          viewBytes: retainedViewBuffer(source, restored.viewBytes),
        }
        if (runtime.restoreAnnotationsOnPrepare) {
          runtime.annotations = restored.annotations
          runtime.savedAnnotationFingerprint = annotationFingerprint(restored.annotations)
          runtime.annotationSequence = restoredAnnotationSequence(restored.annotations)
          runtime.restoreAnnotationsOnPrepare = false
        }
        if (runtime.restoreBookmarksOnPrepare) {
          runtime.bookmarks = restored.bookmarks
          runtime.savedBookmarkFingerprint = pdfBookmarkFingerprint(restored.bookmarks)
          runtime.restoreBookmarksOnPrepare = false
        }
        runtime.viewPrepared = true
      })().finally(() => {
        delete runtime.viewPreparation
      })
    }
    await runtime.viewPreparation
    if (runtime.loaded === undefined || !runtime.viewPrepared) throw new Error('PDF 阅读视图准备未完成')
    return runtime.loaded
  }, [])

  /**
   * Inactive restored tabs retain only their original PDF buffer. Prepare the
   * annotation-stripped render view on first activation instead of parsing and
   * serializing every document during conversation restore.
   */
  const activateRuntime = useCallback((documentId: string): boolean => {
    captureActiveRuntime()
    const runtime = documentRuntimesRef.current.get(documentId)
    if (runtime === undefined) return false
    const activationSequence = ++activationSequenceRef.current
    const previousId = activeDocumentIdRef.current
    if (previousId !== undefined && previousId !== documentId) {
      const previous = documentRuntimesRef.current.get(previousId)
      if (previous?.storedSessionId !== undefined && !previous.needsDocumentPersistence && previous.viewPreparation === undefined) {
        previous.loaded = undefined
        previous.viewPrepared = false
      }
    }
    if (runtime.viewPrepared) return activatePreparedRuntime(documentId)
    setBusy(true)
    void prepareRuntime(runtime).then(() => {
      if (activationSequence !== activationSequenceRef.current) {
        if (runtime.storedSessionId !== undefined && !runtime.needsDocumentPersistence) {
          runtime.loaded = undefined
          runtime.viewPrepared = false
        }
        return
      }
      activatePreparedRuntime(documentId)
    }).catch((cause: unknown) => {
      if (activationSequence === activationSequenceRef.current) {
        setError(`无法准备 PDF 阅读视图：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }).finally(() => {
      if (activationSequence === activationSequenceRef.current) setBusy(false)
    })
    return true
  }, [activatePreparedRuntime, captureActiveRuntime, prepareRuntime])

  /** Release only this plugin's crops; preserve every user-owned draft item. */
  const clearAllComposerSelections = useCallback(() => {
    captureActiveRuntime()
    const records = new Set<ComposerSelectionRecord>()
    for (const runtime of documentRuntimesRef.current.values()) {
      for (const record of runtime.composerSelections) records.add(record)
      runtime.composerSelections = []
    }
    composerSelectionsRef.current = []
    for (const record of records) record.unsubscribe()
    for (const record of records) record.handle.release()
  }, [captureActiveRuntime])

  const replaceEvidenceImages = useCallback((next: readonly PdfEvidenceImage[]): void => {
    setSelectedEvidenceImages(current => reconcilePdfEvidenceSelection(current, new Set(evidenceImagesRef.current), next))
    evidenceImagesRef.current = next
    setEvidenceImages(next)
  }, [])

  /** One transition path keeps local visibility and Harness layout in sync. */
  const changeReaderOpen = useCallback((open: boolean) => {
    if (!open) setInitialViewerSessionState(viewerSessionStateRef.current)
    setReaderOpen(open)
    onWideChangeRef.current(open)
  }, [])

  /** Serialize IndexedDB mutations so an explicit close always wins over older saves. */
  const enqueuePersistence = useCallback((operation: () => Promise<void>): Promise<void> => {
    const task = persistenceQueueRef.current.then(operation, operation)
    persistenceQueueRef.current = task.catch(() => {})
    return task
  }, [])

  const reportPersistenceFailure = useCallback((sessionId: SessionId, cause: unknown): void => {
    if (activeSessionIdRef.current !== sessionId) return
    const detail = cause instanceof Error ? cause.message : String(cause)
    setPersistenceError(`当前 PDF 无法关联到本对话；刷新后可能不能恢复。${detail}`)
  }, [])

  /** Keep at most one pending state snapshot; rapid scroll/selection updates replace it. */
  const enqueueLatestStateSave = useCallback((sessionId: SessionId, state: PdfSessionState): void => {
    pendingStateSaveRef.current = { sessionId, state }
    if (stateSaveDrainQueuedRef.current) return
    stateSaveDrainQueuedRef.current = true
    void enqueuePersistence(async () => {
      try {
        while (pendingStateSaveRef.current !== undefined) {
          const pending = pendingStateSaveRef.current
          pendingStateSaveRef.current = undefined
          await savePdfSessionState(pending.sessionId, pending.state)
        }
      } finally {
        stateSaveDrainQueuedRef.current = false
      }
    }).then(() => {
      if (activeSessionIdRef.current === sessionId) setPersistenceError(undefined)
    }).catch((cause: unknown) => { reportPersistenceFailure(sessionId, cause) })
  }, [enqueuePersistence, reportPersistenceFailure])

  /** Collapse rapid open/save/close changes to one latest document manifest. */
  const enqueueLatestDocumentsSave = useCallback((pending: NonNullable<typeof pendingDocumentsSaveRef.current>): void => {
    pendingDocumentsSaveRef.current = pending
    if (documentsSaveDrainQueuedRef.current) return
    documentsSaveDrainQueuedRef.current = true
    void enqueuePersistence(async () => {
      try {
        while (pendingDocumentsSaveRef.current !== undefined) {
          const next = pendingDocumentsSaveRef.current
          pendingDocumentsSaveRef.current = undefined
          try {
            await savePdfSessionDocuments(next.sessionId, next.activeDocumentId, next.documents)
            for (const body of next.pendingBodies) {
              if (body.runtime.loaded?.bytes !== body.bytes) continue
              body.runtime.needsDocumentPersistence = false
              body.runtime.storedSessionId = next.sessionId
              if (body.runtime.document.documentId !== activeDocumentIdRef.current
                && body.runtime.viewPreparation === undefined) {
                body.runtime.loaded = undefined
                body.runtime.viewPrepared = false
              }
            }
            if (activeSessionIdRef.current === next.sessionId) setPersistenceError(undefined)
          } catch (cause) {
            reportPersistenceFailure(next.sessionId, cause)
          }
        }
      } finally {
        documentsSaveDrainQueuedRef.current = false
      }
    }).catch((cause: unknown) => {
      reportPersistenceFailure(activeSessionIdRef.current, cause)
    })
  }, [enqueuePersistence, reportPersistenceFailure])

  const saveSessionStateSnapshot = useCallback((sessionId: SessionId): void => {
    captureActiveRuntime()
    const activeId = activeDocumentIdRef.current
    if (activeId === undefined || documentRuntimesRef.current.size === 0) return
    const sharedEvidence = sharedEvidenceSnapshotRef.current
    const documents: PdfSessionDocumentState[] = [...documentRuntimesRef.current.values()]
      .map(runtime => ({
        documentId: runtime.document.documentId,
        annotations: runtime.annotations,
        savedAnnotationFingerprint: runtime.savedAnnotationFingerprint,
        bookmarks: runtime.bookmarks,
        savedBookmarkFingerprint: runtime.savedBookmarkFingerprint,
        // Version 2 keeps images once in sharedEvidence. Leave the legacy slot
        // empty so large Base64 strings are not duplicated in IndexedDB writes.
        evidenceImages: [],
        citationBatches: runtime.citationBatches,
        ...(runtime.indexId === undefined ? {} : { indexId: runtime.indexId }),
        ...(runtime.viewer === undefined ? {} : { viewer: runtime.viewer }),
      }))
    const state: PdfSessionState = {
      version: 2,
      readerOpen: panelSnapshotRef.current.readerOpen,
      activeDocumentId: activeId,
      documents,
      sharedEvidence: {
        images: evidenceImagesRef.current,
        texts: sharedEvidence.textEvidence,
        selectedImageIndexes: sharedEvidence.selectedEvidenceImages
          .map(image => evidenceImagesRef.current.indexOf(image))
          .filter(index => index >= 0),
        selectedTextIds: [...sharedEvidence.selectedTextEvidenceIds],
      },
    }
    enqueueLatestStateSave(sessionId, state)
  }, [captureActiveRuntime, enqueueLatestStateSave])

  const scheduleSessionStateSave = useCallback((): void => {
    if (!persistenceEnabledRef.current) return
    if (persistenceTimerRef.current !== undefined) clearTimeout(persistenceTimerRef.current)
    const sessionId = props.sessionId
    persistenceTimerRef.current = setTimeout(() => {
      persistenceTimerRef.current = undefined
      if (!persistenceEnabledRef.current || activeSessionIdRef.current !== sessionId) return
      saveSessionStateSnapshot(sessionId)
    }, PDF_SESSION_SAVE_DELAY_MS)
  }, [props.sessionId, saveSessionStateSnapshot])

  const onViewerSessionStateChange = useCallback((state: PdfViewerSessionState): void => {
    viewerSessionStateRef.current = state
    scheduleSessionStateSave()
  }, [scheduleSessionStateSave])

  const onTextEvidenceChange = useCallback((sources: readonly PdfTextEvidence[]): void => {
    setTextEvidence(sources)
    scheduleSessionStateSave()
  }, [scheduleSessionStateSave])

  const onEvidenceSelectionChange = useCallback((
    images: readonly PdfEvidenceImage[],
    textIds: ReadonlySet<string>,
  ): void => {
    setSelectedEvidenceImages(images)
    setSelectedTextEvidenceIds(new Set(textIds))
    scheduleSessionStateSave()
  }, [scheduleSessionStateSave])

  // Every successful load opens the reader window straight away — the
  // details-column UI is only the fallback file picker, never the reader.
  const accept = useCallback((
    name: string,
    bytes: ArrayBuffer,
    viewBytes: ArrayBuffer,
    restoredAnnotations: readonly PdfTextMarkupAnnotation[],
    restoredBookmarks: readonly PdfBookmark[],
    handle?: PdfFileHandle,
    sourceIdentity?: PdfFileIdentity,
  ) => {
    if (bytes.byteLength > MAX_PDF_BYTES) throw new Error(fileTooLargeMessage(bytes.byteLength))
    if (!hasPdfHeader(bytes)) throw new Error(`文件内容不是有效 PDF: ${name}`)
    const retainedBytes = openPdfBytes(documentRuntimesRef.current)
    if (retainedBytes + bytes.byteLength > MAX_OPEN_PDF_BYTES) {
      throw new Error(`已打开 PDF 的原文件总量将超过 ${String(Math.floor(MAX_OPEN_PDF_BYTES / 1024 / 1024))} MiB，请先关闭部分 PDF`)
    }
    captureActiveRuntime()
    const documentId = createPdfDocumentId()
    const nextLoaded: LoadedPdf = {
      id: ++documentIdRef.current,
      documentId,
      name,
      size: bytes.byteLength,
      bytes,
      viewBytes,
      ...(handle === undefined ? {} : { handle }),
      ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
    }
    documentRuntimesRef.current.set(documentId, {
      document: {
        id: nextLoaded.id,
        documentId,
        name,
        size: bytes.byteLength,
      },
      loaded: nextLoaded,
      viewPrepared: true,
      restoreAnnotationsOnPrepare: false,
      restoreBookmarksOnPrepare: false,
      needsDocumentPersistence: true,
      annotations: restoredAnnotations,
      savedAnnotationFingerprint: annotationFingerprint(restoredAnnotations),
      bookmarks: restoredBookmarks,
      savedBookmarkFingerprint: pdfBookmarkFingerprint(restoredBookmarks),
      viewer: undefined,
      citationBatches: [],
      composerSelections: [],
      selectionSequence: 0,
      annotationSequence: restoredAnnotationSequence(restoredAnnotations),
      citationSequence: 0,
    })
    setDocumentTabs(current => [...current, documentId])
    setDocumentsPersistenceRevision(current => current + 1)
    persistenceEnabledRef.current = true
    setPersistenceError(undefined)
    activateRuntime(documentId)
    setError(undefined)
    changeReaderOpen(true)
  }, [activateRuntime, captureActiveRuntime, changeReaderOpen])

  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => () => {
    persistenceEnabledRef.current = false
    if (persistenceTimerRef.current !== undefined) clearTimeout(persistenceTimerRef.current)
    loadSequenceRef.current += 1
    clearAllComposerSelections()
  }, [clearAllComposerSelections])

  // Restore every PDF associated with this conversation. Only the active tab
  // mounts PdfViewer; restored documents deliberately have no writable handle.
  useEffect(() => {
    const sessionId = props.sessionId
    const sequence = ++loadSequenceRef.current
    activationSequenceRef.current += 1
    persistenceEnabledRef.current = false
    if (persistenceTimerRef.current !== undefined) {
      clearTimeout(persistenceTimerRef.current)
      persistenceTimerRef.current = undefined
    }
    clearAllComposerSelections()
    documentRuntimesRef.current = new Map()
    setDocumentsPersistenceRevision(0)
    activeDocumentIdRef.current = undefined
    setDocumentTabs([])
    setActiveDocumentId(undefined)
    setSelections([])
    replaceEvidenceImages([])
    setTextEvidence([])
    setSelectedEvidenceImages([])
    setSelectedTextEvidenceIds(new Set())
    setAnnotations([])
    setSavedAnnotationFingerprint(annotationFingerprint([]))
    setBookmarks([])
    setSavedBookmarkFingerprint(pdfBookmarkFingerprint([]))
    setSaveBusy(undefined)
    setSaveError(undefined)
    setPersistenceError(undefined)
    setError(undefined)
    setLoaded(undefined)
    setInitialViewerSessionState(undefined)
    viewerSessionStateRef.current = undefined
    selectionSequenceRef.current = 0
    annotationSequenceRef.current = 0
    citationSequenceRef.current = 0
    citationBatchesRef.current = []
    setCitationNavigation(undefined)
    changeReaderOpen(false)
    setBusy(true)

    void loadPdfSession(sessionId).then(async (record) => {
      if (sequence !== loadSequenceRef.current || activeSessionIdRef.current !== sessionId) return
      if (record === undefined) return
      const runtimes = new Map<string, PdfDocumentRuntime>()
      const restoredIds: string[] = []
      const restoredDocumentIds = new Map<string, { documentId: string; documentName: string }>()
      const legacyImages: PdfEvidenceImage[] = []
      const legacyTexts: PdfTextEvidence[] = []
      const requestedStoredActiveId = record.state?.activeDocumentId ?? record.activeDocumentId
      let requestedActiveId: string | undefined
      let restoredBytes = 0
      for (const document of record.documents) {
        if (document.byteLength > MAX_PDF_BYTES) throw new Error(fileTooLargeMessage(document.byteLength))
        restoredBytes += document.byteLength
        if (restoredBytes > MAX_OPEN_PDF_BYTES) {
          throw new Error(`本对话关联 PDF 的原文件总量超过 ${String(Math.floor(MAX_OPEN_PDF_BYTES / 1024 / 1024))} MiB，请清理旧的本地恢复记录后重新打开`)
        }
        const documentId = validPdfDocumentId(document.documentId) ? document.documentId : createPdfDocumentId()
        const storedState = record.state?.documents.find(candidate => candidate.documentId === document.documentId)
        const restoredAnnotations = storedState?.annotations ?? []
        const restoredBookmarks = storedState?.bookmarks ?? []
        const restoredCitations = storedState?.citationBatches ?? []
        const documentMeta = {
          id: ++documentIdRef.current,
          documentId,
          name: document.name,
          size: document.byteLength,
        }
        restoredDocumentIds.set(document.documentId, { documentId, documentName: document.name })
        for (const image of storedState?.evidenceImages ?? []) {
          legacyImages.push({ ...image, documentId, documentName: document.name })
        }
        for (const source of storedState?.viewer?.textEvidence ?? []) {
          legacyTexts.push({
            ...source,
            id: `${documentId}-${source.id}`,
            documentId,
            documentName: document.name,
          })
        }
        runtimes.set(documentId, {
          document: documentMeta,
          loaded: undefined,
          viewPrepared: false,
          restoreAnnotationsOnPrepare: storedState === undefined,
          restoreBookmarksOnPrepare: storedState?.bookmarks === undefined,
          storedSessionId: sessionId,
          needsDocumentPersistence: false,
          annotations: restoredAnnotations,
          savedAnnotationFingerprint: storedState?.savedAnnotationFingerprint ?? annotationFingerprint([]),
          bookmarks: restoredBookmarks,
          savedBookmarkFingerprint: storedState?.savedBookmarkFingerprint ?? pdfBookmarkFingerprint(restoredBookmarks),
          viewer: storedState?.viewer,
          citationBatches: restoredCitations,
          composerSelections: [],
          selectionSequence: 0,
          annotationSequence: restoredAnnotationSequence(restoredAnnotations),
          citationSequence: restoredCitations.length,
          ...(storedState?.indexId === undefined ? {} : { indexId: storedState.indexId }),
        })
        restoredIds.push(documentId)
        if (document.documentId === requestedStoredActiveId) requestedActiveId = documentId
      }
      if (restoredIds.length === 0) return
      documentRuntimesRef.current = runtimes
      setDocumentTabs(restoredIds)
      const shared = record.state?.sharedEvidence
      if (shared === undefined) {
        const boundedImages = boundedPdfEvidenceImages(legacyImages)
        replaceEvidenceImages(boundedImages)
        setSelectedEvidenceImages(boundedImages)
        const boundedTexts = boundedPdfTextEvidence(legacyTexts)
        setTextEvidence(boundedTexts)
        setSelectedTextEvidenceIds(new Set(boundedTexts.map(source => source.id)))
      } else {
        const selectedIndexes = new Set(shared.selectedImageIndexes)
        const restoredImageCandidates = shared.images.flatMap((image, index) => {
          const owner = restoredDocumentIds.get(image.documentId)
          return owner === undefined ? [] : [{ image: { ...image, ...owner }, originalIndex: index }]
        })
        const boundedImageSet = new Set(boundedPdfEvidenceImages(restoredImageCandidates.map(record => record.image)))
        const restoredImages = restoredImageCandidates.filter(record => boundedImageSet.has(record.image))
        const images = restoredImages.map(record => record.image)
        replaceEvidenceImages(images)
        setSelectedEvidenceImages(restoredImages
          .filter(record => selectedIndexes.has(record.originalIndex))
          .map(record => record.image))
        const texts = boundedPdfTextEvidence(shared.texts.flatMap(source => {
          const owner = restoredDocumentIds.get(source.documentId)
          return owner === undefined ? [] : [{ ...source, ...owner }]
        }))
        setTextEvidence(texts)
        const availableTextIds = new Set(texts.map(source => source.id))
        setSelectedTextEvidenceIds(new Set(shared.selectedTextIds.filter(id => availableTextIds.has(id))))
      }
      persistenceEnabledRef.current = true
      activateRuntime(requestedActiveId ?? restoredIds[0]!)
      changeReaderOpen(record.state?.readerOpen ?? true)
    }).catch((cause: unknown) => {
      if (sequence !== loadSequenceRef.current || activeSessionIdRef.current !== sessionId) return
      setError(`无法恢复本对话的 PDF：${cause instanceof Error ? cause.message : String(cause)}`)
      void enqueuePersistence(() => deletePdfSession(sessionId)).catch(() => {})
    }).finally(() => {
      if (sequence === loadSequenceRef.current && activeSessionIdRef.current === sessionId) setBusy(false)
    })
    return () => {
      if (persistenceTimerRef.current !== undefined) {
        clearTimeout(persistenceTimerRef.current)
        persistenceTimerRef.current = undefined
      }
      saveSessionStateSnapshot(sessionId)
    }
  }, [activateRuntime, changeReaderOpen, clearAllComposerSelections, enqueuePersistence, props.sessionId, replaceEvidenceImages, saveSessionStateSnapshot])

  // PDF bytes change only on open or explicit save, so keep their
  // heavier IndexedDB write separate from the lightweight view snapshot.
  useEffect(() => {
    if (!persistenceEnabledRef.current || documentsPersistenceRevision === 0) return
    captureActiveRuntime()
    const activeId = activeDocumentIdRef.current
    if (activeId === undefined) return
    const sessionId = props.sessionId
    const pendingBodies: { runtime: PdfDocumentRuntime; bytes: ArrayBuffer }[] = []
    const documents: Array<{
      documentId: string
      name: string
      byteLength: number
      bytes?: ArrayBuffer
    }> = []
    for (const runtime of documentRuntimesRef.current.values()) {
      const bytes = runtime.needsDocumentPersistence ? runtime.loaded?.bytes : undefined
      if (runtime.needsDocumentPersistence && bytes === undefined) {
        reportPersistenceFailure(sessionId, new Error(`无法保存“${runtime.document.name}”的本地恢复副本`))
        return
      }
      if (bytes !== undefined) pendingBodies.push({ runtime, bytes })
      documents.push({
        documentId: runtime.document.documentId,
        name: runtime.document.name,
        byteLength: runtime.document.size,
        ...(bytes === undefined ? {} : { bytes }),
      })
    }
    enqueueLatestDocumentsSave({
      sessionId,
      activeDocumentId: activeId,
      documents,
      pendingBodies,
    })
  }, [captureActiveRuntime, documentsPersistenceRevision, enqueueLatestDocumentsSave, props.sessionId, reportPersistenceFailure])

  useEffect(() => {
    if (loaded === undefined) return
    scheduleSessionStateSave()
  }, [annotations, bookmarks, evidenceImages, loaded, readerOpen, savedAnnotationFingerprint, savedBookmarkFingerprint, scheduleSessionStateSave, selectedEvidenceImages, selectedTextEvidenceIds, textEvidence])

  useEffect(() => {
    const sessionId = props.sessionId
    const flush = (): void => {
      if (!persistenceEnabledRef.current) return
      if (persistenceTimerRef.current !== undefined) {
        clearTimeout(persistenceTimerRef.current)
        persistenceTimerRef.current = undefined
      }
      saveSessionStateSnapshot(sessionId)
    }
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush) }
  }, [props.sessionId, saveSessionStateSnapshot])

  useEffect(() => () => {
    activationSequenceRef.current += 1
    documentRuntimesRef.current.clear()
    evidenceImagesRef.current = []
  }, [])

  /** Read and validate one browser-selected File. */
  const openFile = useCallback(async (file: File, handle?: PdfFileHandle): Promise<void> => {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError(`不是 PDF 文件: ${file.name}`)
      return
    }
    if (file.size > MAX_PDF_BYTES) {
      setError(fileTooLargeMessage(file.size))
      return
    }
    if (openPdfBytes(documentRuntimesRef.current) + file.size > MAX_OPEN_PDF_BYTES) {
      setError(`已打开 PDF 的原文件总量将超过 ${String(Math.floor(MAX_OPEN_PDF_BYTES / 1024 / 1024))} MiB，请先关闭部分 PDF`)
      return
    }
    const sequence = ++loadSequenceRef.current
    setError(undefined)
    setBusy(true)
    try {
      const bytes = await file.arrayBuffer()
      if (sequence === loadSequenceRef.current) {
        const restored = await loadPdfTextMarkupAnnotations(bytes)
        if (sequence !== loadSequenceRef.current) return
        accept(
          file.name,
          bytes,
          retainedViewBuffer(bytes, restored.viewBytes),
          restored.annotations,
          restored.bookmarks,
          handle,
          handle === undefined ? undefined : pdfFileIdentity(file),
        )
      }
    } catch (cause: unknown) {
      if (sequence === loadSequenceRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (sequence === loadSequenceRef.current) setBusy(false)
    }
  }, [accept])

  // Native Chromium opening retains a writable file handle. Other browsers
  // keep the existing input fallback and still support download-style Save As.
  const requestFile = useCallback(() => {
    setError(undefined)
    if (!supportsNativePdfOpen(window)) {
      fileInput.current?.click()
      return
    }
    void pickPdfFile(window).then(async (picked) => {
      if (picked !== undefined) await openFile(picked.file, picked.handle)
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [openFile])

  // The floating PDF button toggles the loaded reader without discarding its
  // document/view state, or opens the picker when no document exists yet.
  useEffect(() => props.onOpenRequest(() => {
    if (loaded !== undefined) changeReaderOpen(!readerOpen)
    else requestFile()
  }), [props.onOpenRequest, loaded, readerOpen, changeReaderOpen, requestFile])

  useEffect(() => props.onCitationRequest((reference) => {
    let ownerId: string | undefined
    let target: PdfCitationTarget | undefined
    if (reference.kind === 'document') {
      ownerId = documentRuntimesRef.current.has(reference.documentId) ? reference.documentId : undefined
      target = ownerId === undefined ? undefined : resolvePdfCitation([], reference)
    } else {
      for (const [documentId, runtime] of documentRuntimesRef.current) {
        target = resolvePdfCitation(runtime.citationBatches, reference)
        if (target !== undefined) {
          const sourceDocumentId = target.kind === 'document' ? target.source.documentId : target.source.documentId
          ownerId = typeof sourceDocumentId === 'string'
            ? (documentRuntimesRef.current.has(sourceDocumentId) ? sourceDocumentId : undefined)
            : documentId
          break
        }
      }
    }
    if (target === undefined || ownerId === undefined) return false
    activateRuntime(ownerId)
    changeReaderOpen(true)
    setCitationNavigation({ target, revision: ++citationNavigationSequenceRef.current })
    return true
  }), [activateRuntime, changeReaderOpen, props.onCitationRequest])

  const navigateEvidenceImage = useCallback((selection: PdfEvidenceImage): void => {
    if (!activateRuntime(selection.documentId)) return
    changeReaderOpen(true)
    setCitationNavigation({
      target: {
        kind: 'image',
        source: {
          documentId: selection.documentId,
          documentName: selection.documentName,
          pageNumber: selection.pageNumber,
          rect: selection.rect,
          rotation: selection.rotation,
        },
      },
      revision: ++citationNavigationSequenceRef.current,
    })
  }, [activateRuntime, changeReaderOpen])

  const navigateEvidenceText = useCallback((source: PdfTextEvidence): void => {
    if (!activateRuntime(source.documentId)) return
    changeReaderOpen(true)
    setCitationNavigation({
      target: { kind: 'text', source },
      revision: ++citationNavigationSequenceRef.current,
    })
  }, [activateRuntime, changeReaderOpen])

  /** Append one crop without replacing any existing plugin or user attachment. */
  const onSelectionAdd = useCallback((next: SelectionInfo): void => {
    if (loaded === undefined) return

    const sequence = ++selectionSequenceRef.current
    const handle = props.attachSelectionFor(
      props.sessionId,
      selectionFile(loaded.name, next, sequence),
      props.imageLimits,
    )
    const documentId = loaded.documentId
    const record: ComposerSelectionRecord = { documentId, selection: next, handle, unsubscribe: () => {} }
    composerSelectionsRef.current = [...composerSelectionsRef.current, record]
    const unsubscribe = handle.onRemoved(() => {
      const runtime = documentRuntimesRef.current.get(documentId)
      const records = activeDocumentIdRef.current === documentId
        ? composerSelectionsRef.current
        : runtime?.composerSelections ?? []
      if (!records.includes(record)) return
      const nextRecords = records.filter(current => current !== record)
      if (runtime !== undefined) runtime.composerSelections = nextRecords
      if (activeDocumentIdRef.current === documentId) composerSelectionsRef.current = nextRecords
      record.unsubscribe()
      if (activeDocumentIdRef.current === documentId) setSelections(nextRecords.map(current => current.selection))
    })
    record.unsubscribe = unsubscribe
    // onRemoved may have observed an already-absent id synchronously.
    if (!composerSelectionsRef.current.includes(record)) unsubscribe()
    else setSelections(composerSelectionsRef.current.map(current => current.selection))
  }, [loaded, props.attachSelectionFor, props.imageLimits, props.sessionId])

  /** Move one crop out of the ordinary composer and into PDF-owned evidence. */
  const onSelectionMoveToEvidence = useCallback((selection: SelectionInfo): void => {
    if (loaded === undefined) throw new Error('当前 PDF 已关闭，请重新框选')
    const record = composerSelectionsRef.current.find(current => current.selection === selection)
    if (record === undefined) throw new Error('图片附件已经不存在，请重新框选')
    const evidence: PdfEvidenceImage = {
      ...selection,
      documentId: loaded.documentId,
      documentName: loaded.name,
    }
    // Validate before releasing the composer attachment so a bounded-basket
    // error never makes the user's crop disappear.
    const nextEvidence = addPdfEvidenceImage(evidenceImagesRef.current, evidence)
    composerSelectionsRef.current = composerSelectionsRef.current.filter(current => current !== record)
    record.unsubscribe()
    record.handle.release()
    setSelections(composerSelectionsRef.current.map(current => current.selection))
    replaceEvidenceImages(nextEvidence)
  }, [loaded, replaceEvidenceImages])

  const onEvidenceImageRemove = useCallback((selection: PdfEvidenceImage): void => {
    replaceEvidenceImages(evidenceImagesRef.current.filter(current => current !== selection))
  }, [replaceEvidenceImages])

  const onEvidenceImagesClear = useCallback((): void => {
    replaceEvidenceImages([])
    setSelectedEvidenceImages([])
  }, [replaceEvidenceImages])

  const onDocumentActivate = useCallback((documentId: string): void => {
    if (documentId === activeDocumentIdRef.current) return
    if (activateRuntime(documentId)) changeReaderOpen(true)
  }, [activateRuntime, changeReaderOpen])

  /** Close one tab without disturbing the remaining documents. */
  const onDocumentClose = useCallback((documentId: string): void => {
    captureActiveRuntime()
    const runtime = documentRuntimesRef.current.get(documentId)
    if (runtime === undefined) return
    const dirty = annotationFingerprint(runtime.annotations) !== runtime.savedAnnotationFingerprint
      || pdfBookmarkFingerprint(runtime.bookmarks) !== runtime.savedBookmarkFingerprint
    if (dirty && !window.confirm(`“${runtime.document.name}”有尚未保存的批注或书签改动。关闭后这些改动会丢失，是否继续？`)) return
    abortIndexPreparation()
    if (activeOcrScopeRef.current?.bases.some(base => base.documentId === documentId) === true) {
      void revokeActiveOcrScope()
    }
    for (const record of runtime.composerSelections) {
      record.unsubscribe()
      record.handle.release()
    }
    replaceEvidenceImages(evidenceImagesRef.current.filter(image => image.documentId !== documentId))
    const remainingTexts = textEvidence.filter(source => source.documentId !== documentId)
    setTextEvidence(remainingTexts)
    setSelectedTextEvidenceIds(current => {
      const available = new Set(remainingTexts.map(source => source.id))
      return new Set([...current].filter(id => available.has(id)))
    })
    documentRuntimesRef.current.delete(documentId)
    setDocumentsPersistenceRevision(current => current + 1)
    if (runtime.indexId !== undefined) {
      void syncPdfDocumentIndex({
        action: 'clear',
        sessionId: props.sessionId,
        documentId,
        indexId: runtime.indexId,
      }).catch(() => {})
    }
    const index = documentTabs.indexOf(documentId)
    const remaining = documentTabs.filter(candidate => candidate !== documentId)
    setDocumentTabs(remaining)
    if (activeDocumentIdRef.current !== documentId) {
      scheduleSessionStateSave()
      return
    }
    const nextId = remaining[Math.min(Math.max(0, index), remaining.length - 1)]
    if (nextId !== undefined) {
      activateRuntime(nextId)
      scheduleSessionStateSave()
      return
    }
    activeDocumentIdRef.current = undefined
    setActiveDocumentId(undefined)
    composerSelectionsRef.current = []
    evidenceImagesRef.current = []
    citationBatchesRef.current = []
    viewerSessionStateRef.current = undefined
    setLoaded(undefined)
    setSelections([])
    setEvidenceImages([])
    setSelectedEvidenceImages([])
    setTextEvidence([])
    setSelectedTextEvidenceIds(new Set())
    setAnnotations([])
    setBookmarks([])
    setSavedAnnotationFingerprint(annotationFingerprint([]))
    setSavedBookmarkFingerprint(pdfBookmarkFingerprint([]))
    setInitialViewerSessionState(undefined)
    changeReaderOpen(false)
    persistenceEnabledRef.current = false
    pendingStateSaveRef.current = undefined
    pendingDocumentsSaveRef.current = undefined
    const sessionId = props.sessionId
    void enqueuePersistence(() => deletePdfSession(sessionId)).catch((cause: unknown) => {
      if (activeSessionIdRef.current === sessionId) {
        setError(`已关闭 PDF，但无法清除本对话的本地恢复记录：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    })
  }, [abortIndexPreparation, activateRuntime, captureActiveRuntime, changeReaderOpen, documentTabs, enqueuePersistence, props.sessionId, replaceEvidenceImages, revokeActiveOcrScope, scheduleSessionStateSave, textEvidence])

  const onCloseDocument = useCallback((): void => {
    const documentId = activeDocumentIdRef.current
    if (documentId !== undefined) onDocumentClose(documentId)
  }, [onDocumentClose])

  const onDocumentIndexChange = useCallback((documentId: string, indexId: string): void => {
    const runtime = documentRuntimesRef.current.get(documentId)
    if (runtime !== undefined) runtime.indexId = indexId
  }, [])

  /** Remove one crop from both the PDF and composer without touching siblings. */
  const onSelectionRemove = useCallback((selection: SelectionInfo): void => {
    const record = composerSelectionsRef.current.find(current => current.selection === selection)
    if (record === undefined) return
    composerSelectionsRef.current = composerSelectionsRef.current.filter(current => current !== record)
    // Stop observing before releasing: this transition already owns the
    // local removal, while release synchronously removes the composer id.
    record.unsubscribe()
    record.handle.release()
    setSelections(composerSelectionsRef.current.map(current => current.selection))
  }, [])

  const onTextMarkupAdd = useCallback((drafts: readonly PdfTextMarkupDraft[], kind: PdfTextMarkupKind, color: PdfMarkupColor, strokeWidth: PdfMarkupStrokeWidth): string | undefined => {
    const groupId = `markup-${String(++annotationSequenceRef.current)}`
    const next = createPdfTextMarkupAnnotations(drafts, kind, color, strokeWidth, groupId)
    if (next.length === 0) return undefined
    setAnnotations(current => [...current, ...next])
    return groupId
  }, [])

  const onTextMarkupColorChange = useCallback((groupId: string, color: PdfMarkupColor): void => {
    setAnnotations(current => updatePdfTextMarkupGroupColor(current, groupId, color))
  }, [])

  const onTextMarkupRemove = useCallback((groupId: string): void => {
    setAnnotations(current => removePdfTextMarkupGroup(current, groupId))
  }, [])

  const onTextMarkupNoteChange = useCallback((groupId: string, note: string): void => {
    setAnnotations(current => updatePdfTextMarkupGroupNote(current, groupId, note))
  }, [])

  const onTextMarkupStrokeWidthChange = useCallback((groupId: string, strokeWidth: PdfMarkupStrokeWidth): void => {
    setAnnotations(current => updatePdfTextMarkupGroupStrokeWidth(current, groupId, strokeWidth))
  }, [])

  const onBookmarkAdd = useCallback((draft: { parentId: string | null; title: string; pageNumber?: number }): void => {
    setBookmarks(current => {
      try {
        return addPdfBookmark(current, {
          id: `bookmark-${createPdfDocumentId()}`,
          ...draft,
        })
      } catch {
        return current
      }
    })
  }, [])

  const onBookmarkUpdate = useCallback((id: string, draft: { parentId: string | null; title: string; pageNumber?: number }): void => {
    setBookmarks(current => {
      try {
        return updatePdfBookmark(current, id, draft)
      } catch {
        return current
      }
    })
  }, [])

  const onBookmarkRemove = useCallback((id: string): void => {
    setBookmarks(current => removePdfBookmark(current, id))
  }, [])

  const onSaveAs = useCallback(async (): Promise<void> => {
    if (loaded === undefined || saveBusy !== undefined) return
    const annotationSnapshot = annotations
    const bookmarkSnapshot = bookmarks
    const bookmarksDirty = pdfBookmarkFingerprint(bookmarkSnapshot) !== savedBookmarkFingerprint
    setSaveError(undefined)
    setSaveBusy('save-as')
    try {
      const suggestedName = annotatedPdfName(loaded.name)
      const nativeSave = supportsNativePdfSaveAs(window)
      // The native picker must be invoked before the first await in this
      // click chain. Serialize concurrently while the user chooses a target.
      const handlePromise = nativeSave
        ? pickPdfSaveHandle(window, suggestedName)
        : Promise.resolve(undefined)
      const [saved, targetHandle] = await Promise.all([
        savePdfTextMarkupAnnotations(loaded.bytes, annotationSnapshot, {
          ...(bookmarksDirty ? { bookmarks: bookmarkSnapshot } : {}),
        }),
        handlePromise,
      ])
      const savedBuffer = retainedOutputBuffer(saved.bytes)
      if (nativeSave) {
        if (targetHandle === undefined) return
        const file = await writePdfFile(targetHandle, saved.bytes)
        setLoaded(current => {
          if (current?.id !== loaded.id) return current
          const next: LoadedPdf = {
              ...current,
              name: file.name,
              size: saved.bytes.byteLength,
              bytes: savedBuffer,
              ...(annotationSnapshot.length === 0 ? { viewBytes: savedBuffer } : {}),
              handle: targetHandle,
              sourceIdentity: pdfFileIdentity(file),
            }
          const runtime = documentRuntimesRef.current.get(next.documentId)
          if (runtime !== undefined) {
            runtime.loaded = next
            runtime.document = { id: next.id, documentId: next.documentId, name: next.name, size: next.size }
            runtime.needsDocumentPersistence = true
          }
          return next
        })
      } else {
        downloadPdfBytes(saved.bytes, suggestedName)
        setLoaded(current => {
          if (current?.id !== loaded.id) return current
          const next: LoadedPdf = {
              ...current,
              size: saved.bytes.byteLength,
              bytes: savedBuffer,
              ...(annotationSnapshot.length === 0 ? { viewBytes: savedBuffer } : {}),
            }
          const runtime = documentRuntimesRef.current.get(next.documentId)
          if (runtime !== undefined) {
            runtime.loaded = next
            runtime.document = { id: next.id, documentId: next.documentId, name: next.name, size: next.size }
            runtime.needsDocumentPersistence = true
          }
          return next
        })
      }
      setSavedAnnotationFingerprint(annotationFingerprint(annotationSnapshot))
      setSavedBookmarkFingerprint(pdfBookmarkFingerprint(bookmarkSnapshot))
      setDocumentsPersistenceRevision(current => current + 1)
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaveBusy(undefined)
    }
  }, [annotations, bookmarks, loaded, saveBusy, savedBookmarkFingerprint])

  const onOverwrite = useCallback(async (): Promise<void> => {
    if (loaded?.handle === undefined || loaded.sourceIdentity === undefined || saveBusy !== undefined) return
    const annotationSnapshot = annotations
    const bookmarkSnapshot = bookmarks
    const bookmarksDirty = pdfBookmarkFingerprint(bookmarkSnapshot) !== savedBookmarkFingerprint
    setSaveError(undefined)
    setSaveBusy('overwrite')
    try {
      const saved = await savePdfTextMarkupAnnotations(loaded.bytes, annotationSnapshot, {
        ...(bookmarksDirty ? { bookmarks: bookmarkSnapshot } : {}),
      })
      await assertPdfFileUnchanged(loaded.handle, loaded.sourceIdentity)
      const file = await writePdfFile(loaded.handle, saved.bytes)
      const savedBuffer = retainedOutputBuffer(saved.bytes)
      setLoaded(current => {
        if (current?.id !== loaded.id) return current
        const next: LoadedPdf = {
            ...current,
            name: file.name,
            size: saved.bytes.byteLength,
            bytes: savedBuffer,
            ...(annotationSnapshot.length === 0 ? { viewBytes: savedBuffer } : {}),
            sourceIdentity: pdfFileIdentity(file),
          }
        const runtime = documentRuntimesRef.current.get(next.documentId)
        if (runtime !== undefined) {
          runtime.loaded = next
          runtime.document = { id: next.id, documentId: next.documentId, name: next.name, size: next.size }
          runtime.needsDocumentPersistence = true
        }
        return next
      })
      setSavedAnnotationFingerprint(annotationFingerprint(annotationSnapshot))
      setSavedBookmarkFingerprint(pdfBookmarkFingerprint(bookmarkSnapshot))
      setDocumentsPersistenceRevision(current => current + 1)
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaveBusy(undefined)
    }
  }, [annotations, bookmarks, loaded, saveBusy, savedBookmarkFingerprint])

  const onTextReferenceAdd = useCallback((text: string, pageNumbers: readonly number[]): void => {
    if (loaded === undefined) throw new Error('当前没有可引用的 PDF')
    props.appendTextReferenceFor(props.sessionId, {
      documentName: loaded.name,
      pageNumbers,
      text,
    })
  }, [loaded, props.appendTextReferenceFor, props.sessionId])

  const ensureRuntimeIndex = useCallback(async (
    runtime: PdfDocumentRuntime,
    signal: AbortSignal,
  ): Promise<string> => {
    if (runtime.indexId !== undefined) {
      // The mounted reader just published this generation. Inactive/restored
      // tabs are probed because the host process may have restarted.
      if (runtime.document.documentId === activeDocumentIdRef.current) return runtime.indexId
      try {
        await syncPdfDocumentIndex({
          action: 'probe',
          sessionId: props.sessionId,
          documentId: runtime.document.documentId,
          indexId: runtime.indexId,
        }, signal)
        return runtime.indexId
      } catch (cause) {
        if (signal.aborted) throw cause
        delete runtime.indexId
      }
    }
    const releaseAfterIndex = runtime.storedSessionId !== undefined
      && runtime.document.documentId !== activeDocumentIdRef.current
      && !runtime.needsDocumentPersistence
    try {
      let document: LoadedPdf | undefined = await prepareRuntime(runtime)
      const bytes = document.viewBytes
      const documentId = document.documentId
      const documentName = document.name
      if (releaseAfterIndex) {
        runtime.loaded = undefined
        runtime.viewPrepared = false
        document = undefined
      }
      return await buildBackgroundPdfDocumentIndex({
        bytes,
        sessionId: props.sessionId,
        documentId,
        documentName,
        signal,
        onIndexId: (indexId) => { runtime.indexId = indexId },
        transferOwnership: releaseAfterIndex,
      })
    } finally {
      if (releaseAfterIndex) {
        runtime.loaded = undefined
        runtime.viewPrepared = false
      }
    }
  }, [prepareRuntime, props.sessionId])

  const onDocumentsQuestion = useCallback(async (
    question: string,
    documents: readonly { documentId: string; currentPage: number }[],
    ocrPreferences?: PdfOcrPreferences,
  ): Promise<void> => {
    captureActiveRuntime()
    const seen = new Set<string>()
    const selected = documents.flatMap(target => {
      if (seen.has(target.documentId)) return []
      seen.add(target.documentId)
      const runtime = documentRuntimesRef.current.get(target.documentId)
      if (runtime === undefined) throw new Error('所选 PDF 已关闭，请重新选择分析范围')
      return [{ target, runtime, document: runtime.document }]
    })
    if (selected.length === 0) throw new Error('请至少选择一份 PDF')

    abortIndexPreparation()
    await revokeActiveOcrScope()
    const preparationAbort = new AbortController()
    indexPreparationAbortRef.current = preparationAbort
    const prepared: Array<{
      target: { documentId: string; currentPage: number }
      runtime: PdfDocumentRuntime
      document: Pick<LoadedPdf, 'id' | 'documentId' | 'name' | 'size'>
      indexId: string
    }> = []
    try {
      for (const item of selected) {
        prepared.push({ ...item, indexId: await ensureRuntimeIndex(item.runtime, preparationAbort.signal) })
      }
    } finally {
      if (indexPreparationAbortRef.current === preparationAbort) indexPreparationAbortRef.current = undefined
    }

    let aiAccess: PdfDocumentsAiRequest['aiAccess']
    if (ocrPreferences !== undefined) {
      const grantId = createPdfDocumentId()
      const abort = new AbortController()
      const bases = prepared.map(item => ({
        sessionId: props.sessionId,
        documentId: item.document.documentId,
        indexId: item.indexId,
      }))
      const expireTimer = window.setTimeout(() => {
        if (activeOcrScopeRef.current?.grantId === grantId) void revokeActiveOcrScope()
      }, PDF_OCR_GRANT_TTL_MS)
      activeOcrScopeRef.current = { grantId, abort, expireTimer, bases }
      try {
        await Promise.all(prepared.map(async (item, index) => {
          const base = bases[index]!
          await grantPdfOcrAccess(base, {
            grantId,
            currentPage: item.target.currentPage,
            ...ocrPreferences,
          })
        }))
      } catch (cause) {
        await revokeActiveOcrScope()
        throw cause
      }
      for (const item of prepared) {
        let destroyDocument: (() => Promise<void>) | undefined
        void runPdfOcrRelay({
          sessionId: props.sessionId,
          documentId: item.document.documentId,
          indexId: item.indexId,
          signal: abort.signal,
          getDocument: async () => {
            let source: LoadedPdf | undefined = await prepareRuntime(item.runtime)
            const canTransfer = item.runtime.storedSessionId !== undefined
              && item.runtime.document.documentId !== activeDocumentIdRef.current
              && !item.runtime.needsDocumentPersistence
            const bytes = source.viewBytes
            if (canTransfer) {
              item.runtime.loaded = undefined
              item.runtime.viewPrepared = false
              source = undefined
            }
            const task = loadPdfDocument(canTransfer ? bytes : bytes.slice(0))
            destroyDocument = async () => { await task.destroy() }
            try {
              return await task.promise
            } catch (cause) {
              await task.destroy().catch(() => {})
              destroyDocument = undefined
              throw cause
            }
          },
          releaseDocument: async () => {
            const release = destroyDocument
            destroyDocument = undefined
            await release?.()
            if (item.runtime.storedSessionId !== undefined
              && item.runtime.document.documentId !== activeDocumentIdRef.current
              && !item.runtime.needsDocumentPersistence) {
              item.runtime.loaded = undefined
              item.runtime.viewPrepared = false
            }
          },
        }).catch((cause: unknown) => {
          if (!abort.signal.aborted) setError(`PDF OCR 通道异常：${cause instanceof Error ? cause.message : String(cause)}`)
        })
      }
      aiAccess = { grantId, ...ocrPreferences }
    }

    try {
      await props.sendDocumentsQuestionFor(props.sessionId, {
        question,
        documents: prepared.map(item => ({
          documentId: item.document.documentId,
          documentName: item.document.name,
          currentPage: item.target.currentPage,
        })),
        ...(aiAccess === undefined ? {} : { aiAccess }),
      })
      scheduleSessionStateSave()
    } catch (cause) {
      if (aiAccess !== undefined) await revokeActiveOcrScope()
      throw cause
    }
  }, [abortIndexPreparation, captureActiveRuntime, ensureRuntimeIndex, prepareRuntime, props.sendDocumentsQuestionFor, props.sessionId, revokeActiveOcrScope, scheduleSessionStateSave])

  const onTextAiRequest = useCallback(async (
    action: PdfAiAction,
    text: string,
    pageNumbers: readonly number[],
    question?: string,
  ): Promise<void> => {
    if (loaded === undefined) throw new Error('当前没有可分析的 PDF')
    await props.sendTextAiRequestFor(props.sessionId, {
      action,
      ...(question === undefined ? {} : { question }),
      reference: {
        documentName: loaded.name,
        pageNumbers,
        text,
      },
    })
  }, [loaded, props.sendTextAiRequestFor, props.sessionId])

  const onAnnotationAiRequest = useCallback(async (
    action: PdfAnnotationAiAction,
    groups: readonly PdfTextMarkupGroup[],
    question?: string,
  ): Promise<void> => {
    if (loaded === undefined) throw new Error('当前没有可分析的 PDF')
    await props.sendAnnotationAiRequestFor(props.sessionId, {
      action,
      documentName: loaded.name,
      annotations: groups.map(group => ({
        kind: group.kind,
        pageNumbers: group.pageNumbers,
        text: group.text,
        note: group.note,
      })),
      ...(question === undefined ? {} : { question }),
    })
  }, [loaded, props.sendAnnotationAiRequestFor, props.sessionId])

  const onImageAiRequest = useCallback(async (
    action: PdfImageAiAction,
    question?: string,
  ): Promise<void> => {
    if (loaded === undefined) throw new Error('当前没有可分析的 PDF')
    const batch = [...composerSelectionsRef.current]
    if (batch.length === 0) throw new Error('图片选区已经不存在，请重新框选')
    await props.sendImageAiRequestFor(
      props.sessionId,
      batch.map((record, index) => selectionFile(loaded.name, record.selection, index + 1)),
      {
        action,
        ...(question === undefined ? {} : { question }),
        sources: batch.map(record => ({
          documentName: loaded.name,
          pageNumber: record.selection.pageNumber,
          rect: record.selection.rect,
        })),
      },
    )

    // The independent AI turn has consumed exactly this plugin-owned batch.
    // Preserve any crop added while it was in flight and every foreign draft item.
    composerSelectionsRef.current = [...releaseConsumedComposerSelections(
      composerSelectionsRef.current,
      batch,
    )]
    setSelections(composerSelectionsRef.current.map(record => record.selection))
  }, [loaded, props.sendImageAiRequestFor, props.sessionId])

  const onMixedAiRequest = useCallback(async (
    action: PdfMixedAiAction,
    images: readonly PdfEvidenceImage[],
    texts: readonly PdfTextEvidence[],
    question?: string,
  ): Promise<void> => {
    if (loaded === undefined) throw new Error('当前没有可分析的 PDF')
    const available = new Set(evidenceImagesRef.current)
    const batch = [...images]
    if (batch.length === 0) throw new Error('图片选区已经不存在，请重新框选')
    if (batch.some(selection => !available.has(selection))) {
      throw new Error('部分图片资料已经不存在，请重新选择本次提问资料')
    }
    const nonce = [...crypto.getRandomValues(new Uint32Array(2))]
      .map(value => value.toString(36))
      .join('-')
    const citationId = `pdf-${String(loaded.id)}-${String(++citationSequenceRef.current)}-${nonce}`
    await props.sendMixedAiRequestFor(
      props.sessionId,
      batch.map((selection, index) => selectionFile(selection.documentName, selection, index + 1)),
      {
        action,
        ...(question === undefined ? {} : { question }),
        images: batch.map(selection => ({
          documentName: selection.documentName,
          pageNumber: selection.pageNumber,
          rect: selection.rect,
        })),
        texts: texts.map(pdfTextEvidenceReference),
        citationId,
      },
    )

    const citationBatch: PdfCitationBatch = {
      id: citationId,
      documentName: [...new Set([
        ...batch.map(selection => selection.documentName),
        ...texts.map(source => source.documentName),
      ])].join('、'),
      images: batch.map(selection => ({
        documentId: selection.documentId,
        documentName: selection.documentName,
        pageNumber: selection.pageNumber,
        rect: selection.rect,
        rotation: selection.rotation,
      })),
      texts: texts.map(source => ({ ...source, drafts: [...source.drafts] })),
    }
    const involvedDocumentIds = new Set([
      ...batch.map(selection => selection.documentId),
      ...texts.map(source => source.documentId),
    ])
    for (const documentId of involvedDocumentIds) {
      const runtime = documentRuntimesRef.current.get(documentId)
      if (runtime !== undefined) runtime.citationBatches = appendPdfCitationBatch(runtime.citationBatches, citationBatch)
    }
    if (activeDocumentIdRef.current !== undefined && involvedDocumentIds.has(activeDocumentIdRef.current)) {
      citationBatchesRef.current = appendPdfCitationBatch(citationBatchesRef.current, citationBatch)
    }
    scheduleSessionStateSave()

    // The evidence basket is reusable conversation context. Sending never
    // removes its images; only explicit delete/clear and document lifecycle do.
  }, [loaded, props.sendMixedAiRequestFor, props.sessionId, scheduleSessionStateSave])

  const publishOutline = useCallback((outline: PdfOutlineController | undefined): void => {
    props.onOutlineChange(props.sessionId, outline)
  }, [props.onOutlineChange, props.sessionId])

  const viewerDocuments = documentTabs.flatMap(documentId => {
    const runtime = documentRuntimesRef.current.get(documentId)
    const document = documentId === loaded?.documentId ? loaded : runtime?.document
    if (document === undefined) return []
    const documentAnnotations = documentId === loaded?.documentId ? annotations : runtime?.annotations ?? []
    const savedFingerprint = documentId === loaded?.documentId
      ? savedAnnotationFingerprint
      : runtime?.savedAnnotationFingerprint ?? annotationFingerprint([])
    const documentBookmarks = documentId === loaded?.documentId ? bookmarks : runtime?.bookmarks ?? []
    const savedBookmarks = documentId === loaded?.documentId
      ? savedBookmarkFingerprint
      : runtime?.savedBookmarkFingerprint ?? pdfBookmarkFingerprint([])
    return [{
      documentId,
      name: document.name,
      currentPage: runtime?.viewer?.readingAnchor.pageNumber ?? 1,
      editorDirty: annotationFingerprint(documentAnnotations) !== savedFingerprint
        || pdfBookmarkFingerprint(documentBookmarks) !== savedBookmarks,
    }]
  })

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <div style={styles.title}>PDF 阅读器</div>
        <button style={styles.closeButton} title="关闭面板" onClick={props.onClose}>✕</button>
      </div>
      {loaded !== undefined ? (
        <div style={styles.row}>
          <span style={{ ...styles.input, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {loaded.name}
          </span>
          <button style={styles.button} onClick={() => { changeReaderOpen(true) }}>阅读</button>
          <button style={styles.button} disabled={busy} onClick={requestFile}>再打开一份</button>
        </div>
      ) : (
        <div style={styles.intake}>
          <div style={styles.row}>
            <button
              style={{ ...styles.button, flex: 1 }}
              disabled={busy}
              onClick={requestFile}
            >
              选择 PDF 文件…
            </button>
          </div>
          {error !== undefined && <div style={styles.error}>{error}</div>}
          {busy && <div>读取中…</div>}
        </div>
      )}
      {loaded !== undefined && readerOpen && (
        <PdfViewer
          key={loaded.id}
          bytes={loaded.viewBytes}
          sessionId={props.sessionId}
          documentId={loaded.documentId}
          documentName={loaded.name}
          documents={viewerDocuments}
          activeDocumentId={activeDocumentId ?? loaded.documentId}
          onDocumentActivate={onDocumentActivate}
          onDocumentClose={onDocumentClose}
          onDocumentIndexChange={onDocumentIndexChange}
          selections={selections}
          evidenceImages={evidenceImages}
          textEvidence={textEvidence}
          selectedEvidenceImages={selectedEvidenceImages}
          selectedTextEvidenceIds={selectedTextEvidenceIds}
          onTextEvidenceChange={onTextEvidenceChange}
          onEvidenceSelectionChange={onEvidenceSelectionChange}
          annotations={annotations}
          bookmarks={bookmarks}
          onSelectionAdd={onSelectionAdd}
          onSelectionRemove={onSelectionRemove}
          onSelectionMoveToEvidence={onSelectionMoveToEvidence}
          onEvidenceImageRemove={onEvidenceImageRemove}
          onEvidenceImagesClear={onEvidenceImagesClear}
          onTextMarkupAdd={onTextMarkupAdd}
          onTextMarkupColorChange={onTextMarkupColorChange}
          onTextMarkupRemove={onTextMarkupRemove}
          onTextMarkupNoteChange={onTextMarkupNoteChange}
          onTextMarkupStrokeWidthChange={onTextMarkupStrokeWidthChange}
          onBookmarkAdd={onBookmarkAdd}
          onBookmarkUpdate={onBookmarkUpdate}
          onBookmarkRemove={onBookmarkRemove}
          editorDirty={annotationFingerprint(annotations) !== savedAnnotationFingerprint
            || pdfBookmarkFingerprint(bookmarks) !== savedBookmarkFingerprint}
          canOverwrite={loaded.handle !== undefined && loaded.sourceIdentity !== undefined}
          saveBusy={saveBusy}
          saveError={saveError}
          onSaveAs={onSaveAs}
          onOverwrite={onOverwrite}
          onTextReferenceAdd={onTextReferenceAdd}
          onDocumentsQuestion={onDocumentsQuestion}
          onTextAiRequest={onTextAiRequest}
          onAnnotationAiRequest={onAnnotationAiRequest}
          onImageAiRequest={onImageAiRequest}
          onMixedAiRequest={onMixedAiRequest}
          onEvidenceNavigateImage={navigateEvidenceImage}
          onEvidenceNavigateText={navigateEvidenceText}
          citationNavigation={citationNavigation}
          initialSessionState={initialViewerSessionState}
          onSessionStateChange={onViewerSessionStateChange}
          persistenceError={persistenceError}
          onReplace={requestFile}
          onCloseDocument={onCloseDocument}
          replaceBusy={busy}
          replaceError={error}
          imageLimits={props.imageLimits}
          wide
          initialWideWidth={readerWideWidthRef.current}
          onWideWidthChange={(width) => { readerWideWidthRef.current = width }}
          onWideChange={changeReaderOpen}
          onOutlineChange={publishOutline}
          onSearchToggle={props.onSearchToggle}
        />
      )}
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,.pdf"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file !== undefined) void openFile(file)
          // Allow picking the same file twice in a row.
          event.target.value = ''
        }}
      />
    </div>
  )
}
