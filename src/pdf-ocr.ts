/** Shared, JSON-safe protocol for explicitly authorized on-demand PDF OCR. */

export const PDF_OCR_ROUTE = '/plugins/dsh-pdf-reader/ocr'

/** Defaults are conservative; users may raise them after seeing the cost warning. */
export const PDF_OCR_DEFAULT_PAGE_BUDGET = 20
export const PDF_OCR_DEFAULT_PAGES_PER_BATCH = 4
export const PDF_OCR_DEFAULT_VISUAL_BUDGET = 2
export const PDF_OCR_GRANT_TTL_MS = 15 * 60_000
export const PDF_OCR_REQUEST_TIMEOUT_MS = 90_000
export const PDF_OCR_MAX_REQUEST_BYTES = 1_300_000
export const PDF_OCR_MAX_PAGE_IMAGE_BYTES = 750_000
export const PDF_OCR_MAX_PAGE_TEXT_CODE_UNITS = 20_000
export const PDF_OCR_MAX_BATCH_TEXT_CODE_UNITS = 40_000
export const PDF_OCR_RENDER_LONG_EDGE = 1_600

export interface PdfOcrRequestBase {
  sessionId: string
  documentId: string
  indexId: string
}

export interface PdfOcrGrantRequest extends PdfOcrRequestBase {
  action: 'grant'
  grantId: string
  currentPage: number
  maxOcrPages: number
  maxVisualPages: number
  maxPagesPerBatch: number
}

export interface PdfOcrRevokeRequest extends PdfOcrRequestBase {
  action: 'revoke'
  grantId: string
}

export interface PdfOcrPollRequest extends PdfOcrRequestBase {
  action: 'poll'
}

export interface PdfOcrCacheManifestRequest extends PdfOcrRequestBase {
  action: 'cache-manifest'
  /** Pages already recognized on this device; reading them performs no new OCR. */
  pages: readonly number[]
}

export interface PdfOcrPollResponse {
  requestId?: string
  grantId?: string
  pages: readonly number[]
  visualPages: readonly number[]
}

export interface PdfOcrLine {
  text: string
  score: number
  /** Four or more normalized points in page-image coordinates. */
  polygon: readonly { x: number; y: number }[]
}

export interface PdfOcrPageResultRequest extends PdfOcrRequestBase {
  action: 'result'
  requestId: string
  grantId: string
  pageNumber: number
  width: number
  height: number
  lines: readonly PdfOcrLine[]
  durationMs: number
  /** The host uses this to reconcile cache changes after the manifest was sent. */
  fromCache: boolean
  /** Present only when the grant and the tool call requested visual verification. */
  jpegBase64?: string
}

export interface PdfOcrPageErrorRequest extends PdfOcrRequestBase {
  action: 'error'
  requestId: string
  grantId: string
  message: string
}

export type PdfOcrClientRequest =
  | PdfOcrGrantRequest
  | PdfOcrRevokeRequest
  | PdfOcrPollRequest
  | PdfOcrCacheManifestRequest
  | PdfOcrPageResultRequest
  | PdfOcrPageErrorRequest

export interface PdfDocumentAiAccess {
  grantId: string
  maxOcrPages: number
  maxVisualPages: number
  maxPagesPerBatch: number
  currentPage: number
}
