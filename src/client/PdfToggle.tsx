/**
 * The reader's floating entry button: a draggable pill on the frame-wide
 * overlay layer. Interaction contract mirrors the balance badge: a plain
 * click (pointer travel below the threshold) opens the picker when empty or
 * toggles the loaded reader; press-and-move drags the pill anywhere,
 * persisting to localStorage and clamping to the viewport edges.
 * @module dsh-pdf-reader/client/PdfToggle
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { PdfToggleResult } from './workspace-gate.ts'

/** Pointer travel below this distance is a click, not a drag. */
const DRAG_THRESHOLD_PX = 4

/** localStorage key for the pill position. */
const POSITION_KEY = 'dsh-pdf-reader.position.v1'

/** Distance from the viewport edge the pill keeps clear. */
const EDGE_MARGIN_PX = 8

/** How long an unavailable click remains visible. */
const UNAVAILABLE_NOTICE_MS = 2500

/** Pill position: distance from the viewport's right/bottom edges. */
interface Position {
  right: number
  bottom: number
}

/** One in-flight pointer drag session. */
interface DragSession {
  pointerId: number
  startX: number
  startY: number
  right: number
  bottom: number
  moved: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Keep the whole pill inside the current layout viewport. */
function constrainPosition(position: Position, width: number, height: number): Position {
  return {
    right: clamp(position.right, EDGE_MARGIN_PX, Math.max(EDGE_MARGIN_PX, window.innerWidth - width - EDGE_MARGIN_PX)),
    bottom: clamp(position.bottom, EDGE_MARGIN_PX, Math.max(EDGE_MARGIN_PX, window.innerHeight - height - EDGE_MARGIN_PX)),
  }
}

/** Persistent pill position; falls back to the lifted bottom-right corner. */
function loadPosition(): Position {
  try {
    const raw = window.localStorage.getItem(POSITION_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<Position>
      if (typeof parsed.right === 'number' && typeof parsed.bottom === 'number'
        && Number.isFinite(parsed.right) && Number.isFinite(parsed.bottom)) {
        return { right: parsed.right, bottom: parsed.bottom }
      }
    }
  } catch {
    // Corrupt or unavailable storage: the default corner is fine.
  }
  return { right: 16, bottom: 72 }
}

function persistPosition(position: Position): void {
  try {
    window.localStorage.setItem(POSITION_KEY, JSON.stringify(position))
  } catch {
    // Storage may be unavailable; the in-memory position still applies.
  }
}

export interface PdfToggleProps {
  /** Fired on a plain click; returns whether it was handled or why it was unavailable. */
  onToggle: () => PdfToggleResult
}

/** Draggable floating PDF entry pill (the overlay layer is click-through; the pill opts back in). */
export function PdfToggle(props: PdfToggleProps) {
  const [position, setPosition] = useState<Position>(loadPosition)
  const [dragging, setDragging] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const rootRef = useRef<HTMLButtonElement | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  const suppressClickRef = useRef(false)
  const noticeTimerRef = useRef<number | undefined>(undefined)
  const positionRef = useRef(position)
  positionRef.current = position

  const restoreToViewport = useCallback((): void => {
    const root = rootRef.current
    if (root === null) return
    const rect = root.getBoundingClientRect()
    const current = positionRef.current
    const next = constrainPosition(current, rect.width, rect.height)
    if (next.right === current.right && next.bottom === current.bottom) return
    // Update the ref immediately so closely spaced resize events cannot reuse
    // an already-invalid coordinate before React commits the state update.
    positionRef.current = next
    setPosition(next)
  }, [])

  useLayoutEffect(() => {
    restoreToViewport()
    window.addEventListener('resize', restoreToViewport)
    return () => { window.removeEventListener('resize', restoreToViewport) }
  }, [restoreToViewport])

  useEffect(() => () => {
    if (noticeTimerRef.current !== undefined) window.clearTimeout(noticeTimerRef.current)
  }, [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    const root = rootRef.current
    if (root === null) return
    // Never retain the hover hint through pointer capture: Chrome can keep a
    // native title tooltip alive even after the title attribute is removed.
    setHovered(false)
    root.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      right: positionRef.current.right,
      bottom: positionRef.current.bottom,
      moved: false,
    }
  }, [])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return
    if (!drag.moved) {
      drag.moved = true
      setDragging(true)
    }
    const root = rootRef.current
    if (root === null) return
    const rect = root.getBoundingClientRect()
    setPosition(constrainPosition({ right: drag.right - dx, bottom: drag.bottom - dy }, rect.width, rect.height))
  }, [])

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>, completed: boolean): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    suppressClickRef.current = completed && drag.moved
    if (drag.moved) {
      persistPosition(positionRef.current)
    }
  }, [])

  const activate = useCallback((): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    const result = props.onToggle()
    if (noticeTimerRef.current !== undefined) window.clearTimeout(noticeTimerRef.current)
    if (result === 'handled') {
      noticeTimerRef.current = undefined
      setNotice(undefined)
    } else {
      setNotice('还没进入会话，请先打开一个会话')
      noticeTimerRef.current = window.setTimeout(() => {
        noticeTimerRef.current = undefined
        setNotice(undefined)
      }, UNAVAILABLE_NOTICE_MS)
    }
  }, [props])

  return (
    <button
      ref={rootRef}
      aria-label="显示或收起 PDF 阅读器"
      onClick={activate}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => { finishDrag(event, true) }}
      onPointerCancel={(event) => { finishDrag(event, false) }}
      onPointerEnter={() => { setHovered(true) }}
      onPointerLeave={() => { setHovered(false) }}
      style={{
        position: 'fixed',
        right: `${String(position.right)}px`,
        bottom: `${String(position.bottom)}px`,
        // Stay reachable even when dragged over the reader window (z-index 300).
        zIndex: 320,
        pointerEvents: 'auto',
        padding: '4px 12px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-primary, #ccc)',
        background: 'var(--dsw-alias-bg-primary, #fff)',
        color: 'var(--dsw-alias-content-secondary, #555)',
        fontSize: '12px',
        cursor: dragging ? 'grabbing' : 'grab',
        userSelect: 'none',
        touchAction: 'none',
      }}
    >
      PDF
      {(notice !== undefined || (hovered && !dragging)) && (
        <span
          role={notice !== undefined ? 'status' : 'tooltip'}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 'calc(100% + 6px)',
            padding: '4px 8px',
            borderRadius: '4px',
            background: 'rgba(38,38,38,0.9)',
            color: '#fff',
            boxShadow: '0 2px 8px rgba(0,0,0,0.22)',
            fontSize: '12px',
            fontWeight: 400,
            lineHeight: 1.4,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {notice ?? '显示或收起 PDF 阅读器（可拖动）'}
        </span>
      )}
    </button>
  )
}
