/** Browser-side resource limits for the PDF reader. */

/**
 * Provisional raw-document ceiling for the file picker. Target-device
 * benchmarks may justify a lower supported limit.
 */
export const MAX_PDF_BYTES = 300 * 1024 * 1024

/** Bound raw PDF buffers retained by one conversation across all open tabs. */
export const MAX_OPEN_PDF_BYTES = 512 * 1024 * 1024

/** Intended maximum edge of every pdf.js canvas backing store. */
export const MAX_CANVAS_DIMENSION = 4_096
