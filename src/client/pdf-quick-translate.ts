/**
 * Browser half of the reader's quick translation: one same-origin request to
 * the host route and the failure copy the popover shows.
 *
 * The route answers a dictionary line for one selected word or short phrase;
 * it never opens a conversation turn, so nothing here touches the Session.
 * @module dsh-pdf-reader/client/pdf-quick-translate
 */

import {
  normalizedPdfTranslation,
  parsePdfTranslateRequest,
  PDF_TRANSLATE_ROUTE,
  PDF_TRANSLATE_TIMEOUT_MS,
} from '../pdf-translate.ts'

/** One successful quick translation. */
export interface PdfQuickTranslation {
  /** Normalized selection the translation belongs to. */
  readonly text: string
  readonly translation: string
}

/** A translation attempt that produced no usable answer. */
export class PdfQuickTranslationError extends Error {
  /** @param message - displayable Chinese reason. */
  constructor(message: string) {
    super(message)
    this.name = 'PdfQuickTranslationError'
  }
}

/**
 * Translate one selection through the host route.
 * @param selection - raw selected text; it is normalized here as well so a
 * caller that skipped the shared helper still sends a valid body.
 * @param signal - caller cancellation (popover close, reader teardown).
 * @returns the normalized source text and its translation.
 * @throws {PdfQuickTranslationError} for input, transport, and model failures.
 */
export async function requestPdfQuickTranslation(
  selection: string,
  signal?: AbortSignal,
): Promise<PdfQuickTranslation> {
  const payload = parsePdfTranslateRequest({ text: selection })
  if (payload === undefined) {
    throw new PdfQuickTranslationError('请选择一个单词或较短的短语再翻译')
  }

  // The route owns the model call; the browser only waits for its answer. A
  // client-side deadline keeps a stalled request from pinning the popover.
  const timeout = AbortSignal.timeout(PDF_TRANSLATE_TIMEOUT_MS + 5_000)
  const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  let response: Response
  try {
    response = await fetch(PDF_TRANSLATE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: composed,
    })
  } catch (cause) {
    if (signal?.aborted === true) throw new PdfQuickTranslationError('已取消翻译')
    if ((cause as { name?: unknown } | null)?.name === 'TimeoutError') {
      throw new PdfQuickTranslationError('翻译超时，请稍后再试')
    }
    throw new PdfQuickTranslationError(`无法连接翻译服务：${errorMessage(cause)}`)
  }

  // An unmatched route answers a bare 404 with no body, so read the text once
  // and report the status instead of pretending the payload was malformed.
  let raw = ''
  try {
    raw = await response.text()
  } catch {
    raw = ''
  }
  let body: unknown
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw)
    } catch {
      body = undefined
    }
  }
  if (typeof body !== 'object' || body === null) {
    throw new PdfQuickTranslationError(translationRouteFailure(response.status))
  }
  const record = body as { ok?: unknown; translation?: unknown; error?: unknown }
  if (record.ok !== true) {
    throw new PdfQuickTranslationError(
      typeof record.error === 'string' && record.error.length > 0
        ? record.error.slice(0, 300)
        : `翻译失败（HTTP ${String(response.status)}）`,
    )
  }
  if (typeof record.translation !== 'string') {
    throw new PdfQuickTranslationError('翻译服务没有返回译文')
  }
  const translation = normalizedPdfTranslation(record.translation)
  if (translation.length === 0) throw new PdfQuickTranslationError('模型没有返回可用的译文')
  return { text: payload.text, translation }
}

/**
 * Read one failure as display copy.
 * @param cause - anything a rejected translation surfaces.
 * @returns the message to show, never empty.
 */
export function quickTranslationErrorText(cause: unknown): string {
  const message = errorMessage(cause).trim()
  return message.length === 0 ? '翻译失败' : message
}

/**
 * Explain one response that carried no usable JSON body.
 * @param status - HTTP status the route answered with.
 * @returns display copy naming the actionable cause when it is known.
 */
function translationRouteFailure(status: number): string {
  // The Host half registers this route when `apply` runs, so a running
  // instance started before the plugin was rebuilt knows nothing about it.
  if (status === 404) return '翻译路由未加载（HTTP 404）：请重启 dsh web 后再试'
  if (status === 403) return '翻译请求被拒绝（HTTP 403）：请从 Harness 页面重新打开阅读器'
  return `翻译服务不可用（HTTP ${String(status)}）`
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
