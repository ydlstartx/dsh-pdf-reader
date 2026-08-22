/** Lazily loaded PaddleOCR browser runtime, served outside Harness's frozen module table. */

import { PaddleOCR } from '@paddleocr/paddleocr-js'

export async function createPdfOcrEngine(): Promise<Awaited<ReturnType<typeof PaddleOCR.create>>> {
  return await PaddleOCR.create({
    lang: 'ch',
    ocrVersion: 'PP-OCRv5',
    worker: {
      createWorker: () => new Worker(new URL('./ocr-worker.js', import.meta.url), { type: 'module' }),
    },
    ortOptions: { backend: 'auto', numThreads: 1, simd: true },
  })
}
