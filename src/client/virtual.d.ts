/** Virtual pdf.js worker source module (inlined by tsdown.config.ts). */
declare module 'virtual:pdfjs-worker' {
  const source: string
  export default source
}

/** Base64 pdf.js CMaps, fallback fonts, and codec WASM, keyed by request kind and filename. */
declare module 'virtual:pdfjs-binary-data' {
  const encoded: Readonly<Record<string, string>>
  export default encoded
}
