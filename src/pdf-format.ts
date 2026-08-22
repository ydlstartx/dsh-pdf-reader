/** PDF byte checks used at the browser file-picker boundary. */

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d] as const // %PDF-

/** PDF headers may legally appear within the first 1024 bytes. */
export function hasPdfHeader(input: ArrayBuffer | Uint8Array): boolean {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const searchLength = Math.min(bytes.length, 1024)
  for (let offset = 0; offset <= searchLength - PDF_HEADER.length; offset += 1) {
    if (PDF_HEADER.every((value, index) => bytes[offset + index] === value)) return true
  }
  return false
}
