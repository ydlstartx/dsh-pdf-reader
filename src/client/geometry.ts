/** Pure wide-reader geometry with one narrow-viewport fallback policy. */

export const MIN_READER_WIDTH = 360
export const MIN_CONVERSATION_WIDTH = 360

export interface WideGeometry {
  overlay: boolean
  left: number
  panelWidth: number
}

/**
 * Keep both reader and conversation usable when possible; otherwise cover the
 * viewport with the reader instead of pretending every minimum can fit.
 *
 * The Harness frame keeps three tracks: the left sidebar (zero while it is a
 * drawer overlay), the centre conversation, and the right Sidebar. The reader
 * docks between the first two, so both outer tracks are width it cannot use —
 * ignoring the right one is what pushed the conversation under the reader.
 * @param viewportWidth - current layout viewport width.
 * @param sidebarWidth - left column width that consumes a grid track.
 * @param rightbarWidth - right column width that consumes a grid track.
 * @param preferredWidth - caller-chosen reader width, or 0 for the automatic share.
 * @returns the docked left edge and width, or a full-viewport overlay.
 */
export function computeWideGeometry(
  viewportWidth: number,
  sidebarWidth: number,
  rightbarWidth: number,
  preferredWidth: number,
): WideGeometry {
  const viewport = Math.max(0, viewportWidth)
  const sidebar = Math.max(0, Math.min(sidebarWidth, viewport))
  const rightbar = Math.max(0, Math.min(rightbarWidth, viewport - sidebar))
  const available = viewport - sidebar - rightbar
  if (available < MIN_READER_WIDTH + MIN_CONVERSATION_WIDTH) {
    return { overlay: true, left: 0, panelWidth: viewport }
  }
  const maxPanel = available - MIN_CONVERSATION_WIDTH
  const desired = preferredWidth > 0 ? preferredWidth : Math.round(available * 0.55)
  const panelWidth = Math.min(maxPanel, Math.max(MIN_READER_WIDTH, desired))
  return { overlay: false, left: sidebar, panelWidth }
}
