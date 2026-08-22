/** Scheduling and early-stop policy for automatic native-text indexing. */

/** Enough consecutive leading pages to distinguish a scanned document cheaply. */
export const PDF_IMAGE_ONLY_PROBE_PAGES = 32

/** Do not walk a thousand-page image-only PDF merely to rediscover empty text. */
export function shouldStopAutomaticPdfIndex(input: {
  indexedPages: number
  totalPages: number
  codeUnits: number
}): boolean {
  return input.totalPages > PDF_IMAGE_ONLY_PROBE_PAGES
    && input.indexedPages >= PDF_IMAGE_ONLY_PROBE_PAGES
    && input.codeUnits === 0
}

interface PdfIndexIdleWindow {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

/** Yield each extraction batch until the browser is idle, with a finite fallback. */
export function waitForPdfIndexIdle(signal: AbortSignal, host: Window = window): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<void>((resolve, reject) => {
    const idleHost = host as unknown as PdfIndexIdleWindow
    let timer: number | undefined
    let idleHandle: number | undefined
    const cleanup = (): void => {
      if (timer !== undefined) host.clearTimeout(timer)
      if (idleHandle !== undefined) idleHost.cancelIdleCallback?.(idleHandle)
      signal.removeEventListener('abort', abort)
    }
    const complete = (): void => { cleanup(); resolve() }
    const abort = (): void => { cleanup(); reject(new DOMException('Aborted', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    if (idleHost.requestIdleCallback !== undefined) {
      idleHandle = idleHost.requestIdleCallback(complete, { timeout: 250 })
    } else {
      timer = host.setTimeout(complete, 32)
    }
  })
}
