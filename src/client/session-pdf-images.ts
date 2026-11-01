/** Official Harness SessionFace boundary for one browser-owned image turn. */

import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'

function bytesToBase64(data: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < data.length; offset += chunk) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/** Queue ordered PNG images plus their exact task prompt through the public session contract. */
export async function sendPdfImageTurn(
  session: SessionFace,
  text: string,
  images: readonly File[],
): Promise<void> {
  if (images.length === 0) throw new Error('没有可发送的 PDF 图片选区')
  const imageParts = await Promise.all(images.map(async image => ({
    type: 'image' as const,
    mediaType: 'image/png' as const,
    data: bytesToBase64(new Uint8Array(await image.arrayBuffer())),
    ...(image.name === '' ? {} : { name: image.name }),
  })))
  const result = await session.prompt([
    ...imageParts,
    ...(text.length === 0 ? [] : [{ type: 'text' as const, text }]),
  ], 'queue')
  if (!result.ok) {
    throw new Error(`PDF 图片对话发送失败：${result.error.code}: ${result.error.message}`)
  }
}
