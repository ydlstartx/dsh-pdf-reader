import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { MAX_PDF_AI_QUESTION_CODE_UNITS } from './composer-pdf-reference.ts'
import type { PdfAnnotationAiAction } from './composer-pdf-reference.ts'
import {
  MAX_PDF_ANNOTATION_NOTE_LENGTH,
  PDF_MARKUP_COLORS,
  groupPdfTextMarkupAnnotations,
  pdfTextMarkupKindLabel,
} from './pdf-annotations.ts'
import type { PdfTextMarkupAnnotation, PdfTextMarkupGroup, PdfTextMarkupKind } from './pdf-annotations.ts'

type PdfAnnotationFilter = 'all' | PdfTextMarkupKind
const ANNOTATION_LIST_BATCH = 200

function pageLabel(pageNumbers: readonly number[]): string {
  if (pageNumbers.length === 0) return '未知页码'
  if (pageNumbers.length === 1) return `第 ${String(pageNumbers[0])} 页`
  if (pageNumbers.length <= 3) return `第 ${pageNumbers.join('、')} 页`
  return `第 ${String(pageNumbers[0])}–${String(pageNumbers.at(-1))} 页`
}

const styles = {
  drawer: {
    position: 'absolute',
    zIndex: 15,
    top: '12px',
    bottom: '12px',
    left: '12px',
    display: 'flex',
    flexDirection: 'column',
    width: '296px',
    maxWidth: 'calc(100% - 24px)',
    overflow: 'hidden',
    border: '1px solid rgba(0,0,0,0.14)',
    borderRadius: '12px',
    background: 'rgba(255,255,255,0.98)',
    color: '#262626',
    boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
    backdropFilter: 'blur(10px)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: '42px',
    padding: '0 8px 0 13px',
    borderBottom: '1px solid #ececec',
  },
  title: { fontSize: '13px', fontWeight: 650 },
  close: {
    width: '28px',
    height: '28px',
    padding: 0,
    border: 'none',
    borderRadius: '7px',
    background: 'transparent',
    color: '#595959',
    cursor: 'pointer',
    fontSize: '19px',
    lineHeight: 1,
  },
  filters: {
    display: 'flex',
    gap: '4px',
    padding: '8px',
    borderBottom: '1px solid #f0f0f0',
    overflowX: 'auto',
  },
  aiArea: {
    position: 'relative',
    padding: '8px',
    borderBottom: '1px solid #f0f0f0',
  },
  aiButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    width: '100%',
    height: '32px',
    padding: '0 10px',
    border: 'none',
    borderRadius: '8px',
    background: 'rgba(77,107,254,0.11)',
    color: '#3154d8',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '11px',
    fontWeight: 650,
  },
  aiButtonDisabled: { cursor: 'default', opacity: 0.45 },
  aiMenu: {
    position: 'absolute',
    zIndex: 3,
    top: '46px',
    left: '8px',
    right: '8px',
    padding: '5px',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: '10px',
    background: '#fff',
    boxShadow: '0 7px 22px rgba(0,0,0,0.2)',
  },
  aiMenuItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    width: '100%',
    gap: '2px',
    padding: '8px 9px',
    border: 'none',
    borderRadius: '7px',
    background: 'transparent',
    color: '#303034',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
  },
  aiMenuLabel: { fontSize: '12px', fontWeight: 650, lineHeight: '16px' },
  aiMenuHint: { color: '#83838a', fontSize: '10px', lineHeight: '14px' },
  aiQuestion: { padding: '4px' },
  aiQuestionTitle: { marginBottom: '6px', color: '#555', fontSize: '11px', lineHeight: '16px' },
  aiError: { marginTop: '6px', color: '#c23b32', fontSize: '10px', lineHeight: '15px' },
  filter: {
    flex: '0 0 auto',
    height: '27px',
    padding: '0 8px',
    border: 'none',
    borderRadius: '7px',
    background: 'transparent',
    color: '#666',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '11px',
  },
  list: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 8px 12px' },
  item: {
    marginBottom: '5px',
    border: '1px solid transparent',
    borderRadius: '10px',
    background: 'transparent',
  },
  navigate: {
    display: 'block',
    width: '100%',
    padding: '9px 9px 7px',
    border: 'none',
    borderRadius: '9px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
  },
  meta: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
  swatch: {
    flex: '0 0 auto',
    width: '9px',
    height: '9px',
    borderRadius: '50%',
    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.1)',
  },
  kind: { fontSize: '11px', fontWeight: 650, color: '#4b4b4b' },
  pages: { marginLeft: 'auto', fontSize: '10px', color: '#8a8a8a' },
  excerpt: {
    display: '-webkit-box',
    marginTop: '5px',
    overflow: 'hidden',
    color: '#353535',
    fontSize: '12px',
    lineHeight: '17px',
    overflowWrap: 'anywhere',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 3,
  },
  note: {
    display: '-webkit-box',
    marginTop: '5px',
    paddingLeft: '7px',
    overflow: 'hidden',
    borderLeft: '2px solid #d8d8d8',
    color: '#777',
    fontSize: '11px',
    lineHeight: '16px',
    overflowWrap: 'anywhere',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: '3px', padding: '0 7px 7px' },
  action: {
    height: '25px',
    padding: '0 7px',
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: '#696969',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '10px',
  },
  deleteAction: { color: '#b9473f' },
  editor: { padding: '0 8px 8px' },
  textarea: {
    display: 'block',
    width: '100%',
    minHeight: '74px',
    padding: '7px 8px',
    resize: 'vertical',
    border: '1px solid #d8d8d8',
    borderRadius: '8px',
    outline: 'none',
    boxSizing: 'border-box',
    background: '#fff',
    color: '#292929',
    fontFamily: 'inherit',
    fontSize: '12px',
    lineHeight: '17px',
  },
  editorFooter: { display: 'flex', alignItems: 'center', marginTop: '5px' },
  count: { color: '#999', fontSize: '10px' },
  editorActions: { display: 'flex', gap: '4px', marginLeft: 'auto' },
  saveAction: { background: '#4d6bfe', color: '#fff' },
  empty: { padding: '28px 16px', color: '#888', fontSize: '12px', lineHeight: '19px', textAlign: 'center' },
  loadMore: {
    display: 'block',
    width: '100%',
    height: '32px',
    marginTop: '4px',
    border: 'none',
    borderRadius: '8px',
    background: '#f2f2f3',
    color: '#555',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '11px',
  },
} satisfies Record<string, CSSProperties>

const FILTERS: readonly { id: PdfAnnotationFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'highlight', label: '高亮' },
  { id: 'underline', label: '下划线' },
  { id: 'strikeout', label: '删除线' },
]

export function PdfAnnotationDrawer(props: {
  annotations: readonly PdfTextMarkupAnnotation[]
  onNavigate: (annotation: PdfTextMarkupAnnotation) => void
  onNoteChange: (groupId: string, note: string) => void
  onRemove: (groupId: string) => void
  onAiRequest: (action: PdfAnnotationAiAction, groups: readonly PdfTextMarkupGroup[], question?: string) => Promise<void>
  onClose: () => void
}) {
  const [filter, setFilter] = useState<PdfAnnotationFilter>('all')
  const [visibleLimit, setVisibleLimit] = useState(ANNOTATION_LIST_BATCH)
  const [editingGroupId, setEditingGroupId] = useState<string | undefined>(undefined)
  const [noteDraft, setNoteDraft] = useState('')
  const [aiMenuOpen, setAiMenuOpen] = useState(false)
  const [aiQuestionOpen, setAiQuestionOpen] = useState(false)
  const [aiQuestionDraft, setAiQuestionDraft] = useState('')
  const [aiBusy, setAiBusy] = useState<PdfAnnotationAiAction | undefined>(undefined)
  const [aiError, setAiError] = useState<string | undefined>(undefined)
  const groups = useMemo(() => groupPdfTextMarkupAnnotations(props.annotations), [props.annotations])
  const visibleGroups = filter === 'all' ? groups : groups.filter(group => group.kind === filter)
  const renderedGroups = visibleGroups.slice(0, visibleLimit)

  useEffect(() => {
    if (editingGroupId !== undefined && !groups.some(group => group.groupId === editingGroupId)) {
      setEditingGroupId(undefined)
      setNoteDraft('')
    }
  }, [editingGroupId, groups])

  const submitAi = (action: PdfAnnotationAiAction, question?: string): void => {
    if (aiBusy !== undefined || visibleGroups.length === 0) return
    setAiError(undefined)
    setAiBusy(action)
    void props.onAiRequest(action, visibleGroups, question).then(() => {
      setAiMenuOpen(false)
      setAiQuestionOpen(false)
      setAiQuestionDraft('')
    }).catch((cause: unknown) => {
      setAiError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { setAiBusy(undefined) })
  }

  return (
    <aside data-pdf-annotation-drawer="true" aria-label="PDF 批注中心" style={styles.drawer}>
      <div style={styles.header}>
        <span style={styles.title}>批注 · {String(groups.length)}</span>
        <button type="button" aria-label="关闭批注中心" style={styles.close} onClick={props.onClose}>×</button>
      </div>
      <div role="tablist" aria-label="筛选 PDF 批注" style={styles.filters}>
        {FILTERS.map(option => {
          const selected = option.id === filter
          const count = option.id === 'all' ? groups.length : groups.filter(group => group.kind === option.id).length
          return (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-pdf-annotation-filter={option.id}
              style={{
                ...styles.filter,
                ...(selected ? { background: '#eeeeef', color: '#2f2f2f', fontWeight: 650 } : {}),
              }}
              onClick={() => {
                setFilter(option.id)
                setVisibleLimit(ANNOTATION_LIST_BATCH)
                setAiMenuOpen(false)
                setAiQuestionOpen(false)
                setAiError(undefined)
              }}
            >
              {option.label} {String(count)}
            </button>
          )
        })}
      </div>
      <div data-pdf-annotation-ai="true" style={styles.aiArea}>
        <button
          type="button"
          data-pdf-annotation-ai-button="true"
          aria-haspopup="menu"
          aria-expanded={aiMenuOpen}
          disabled={visibleGroups.length === 0 || aiBusy !== undefined}
          style={{
            ...styles.aiButton,
            ...(visibleGroups.length === 0 || aiBusy !== undefined ? styles.aiButtonDisabled : {}),
          }}
          onClick={() => {
            setAiError(undefined)
            setAiQuestionOpen(false)
            setAiMenuOpen(open => !open)
          }}
        >
          <span aria-hidden="true">✦</span>
          <span>{aiBusy === undefined ? `AI 分析当前 ${String(visibleGroups.length)} 条` : '正在发送…'}</span>
          <span aria-hidden="true">⌄</span>
        </button>
        {aiMenuOpen && (
          <div data-pdf-annotation-ai-menu="true" role="menu" aria-label="批注 AI 分析" style={styles.aiMenu}>
            {!aiQuestionOpen ? (
              <>
                <button type="button" role="menuitem" data-pdf-annotation-ai-action="summarize" style={styles.aiMenuItem} onClick={() => { submitAi('summarize') }}>
                  <span style={styles.aiMenuLabel}>总结批注</span>
                  <span style={styles.aiMenuHint}>提炼核心结论、概念和论据关系</span>
                </button>
                <button type="button" role="menuitem" data-pdf-annotation-ai-action="organize" style={styles.aiMenuItem} onClick={() => { submitAi('organize') }}>
                  <span style={styles.aiMenuLabel}>梳理脉络</span>
                  <span style={styles.aiMenuHint}>按主题整理结构，而不是机械按页复述</span>
                </button>
                <button type="button" role="menuitem" data-pdf-annotation-ai-action="review" style={styles.aiMenuItem} onClick={() => { submitAi('review') }}>
                  <span style={styles.aiMenuLabel}>发现问题</span>
                  <span style={styles.aiMenuHint}>查找矛盾、论证缺口和待核对内容</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-pdf-annotation-ai-action="question"
                  style={styles.aiMenuItem}
                  onClick={() => {
                    setAiQuestionOpen(true)
                    setAiQuestionDraft('')
                  }}
                >
                  <span style={styles.aiMenuLabel}>深入提问…</span>
                  <span style={styles.aiMenuHint}>围绕当前筛选的批注提出自己的问题</span>
                </button>
              </>
            ) : (
              <form
                data-pdf-annotation-ai-question="true"
                style={styles.aiQuestion}
                onSubmit={(event) => {
                  event.preventDefault()
                  submitAi('question', aiQuestionDraft)
                }}
              >
                <div style={styles.aiQuestionTitle}>围绕当前 {String(visibleGroups.length)} 条批注提问</div>
                <textarea
                  autoFocus
                  aria-label="批注集合问题"
                  placeholder="例如：这些批注之间有哪些共同前提？"
                  maxLength={MAX_PDF_AI_QUESTION_CODE_UNITS}
                  value={aiQuestionDraft}
                  style={styles.textarea}
                  onChange={(event) => { setAiQuestionDraft(event.target.value) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation()
                      setAiQuestionOpen(false)
                    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      submitAi('question', aiQuestionDraft)
                    }
                  }}
                />
                <div style={styles.editorFooter}>
                  <span style={styles.count}>{String(aiQuestionDraft.length)} / {String(MAX_PDF_AI_QUESTION_CODE_UNITS)}</span>
                  <span style={styles.editorActions}>
                    <button type="button" style={styles.action} onClick={() => { setAiQuestionOpen(false) }}>返回</button>
                    <button
                      type="submit"
                      data-pdf-annotation-ai-send="true"
                      disabled={aiBusy !== undefined || aiQuestionDraft.trim().length === 0}
                      style={{ ...styles.action, ...styles.saveAction }}
                    >
                      {aiBusy === 'question' ? '发送中…' : '发送'}
                    </button>
                  </span>
                </div>
              </form>
            )}
          </div>
        )}
        {aiError !== undefined && <div role="alert" data-pdf-annotation-ai-error="true" style={styles.aiError}>{aiError}</div>}
      </div>
      <div data-pdf-annotation-list="true" style={styles.list}>
        {visibleGroups.length === 0 && (
          <div style={styles.empty}>
            {groups.length === 0 ? '还没有批注。选择 PDF 文字后即可添加高亮、下划线或删除线。' : '当前筛选条件下没有批注。'}
          </div>
        )}
        {renderedGroups.map(group => {
          const color = PDF_MARKUP_COLORS.find(option => option.id === group.color) ?? PDF_MARKUP_COLORS[0]!
          const editing = editingGroupId === group.groupId
          return (
            <article
              key={group.groupId}
              data-pdf-annotation-list-item="true"
              data-pdf-annotation-group={group.groupId}
              style={{ ...styles.item, ...(editing ? { borderColor: '#d9d9dc', background: '#fafafa' } : {}) }}
            >
              <button type="button" style={styles.navigate} onClick={() => { props.onNavigate(group.first) }}>
                <span style={styles.meta}>
                  <span aria-hidden="true" style={{ ...styles.swatch, background: color.hex }} />
                  <span style={styles.kind}>{pdfTextMarkupKindLabel(group.kind)}</span>
                  <span style={styles.pages}>{pageLabel(group.pageNumbers)}</span>
                </span>
                <span style={styles.excerpt}>{group.text || '此批注未保存原文'}</span>
                {group.note.length > 0 && <span style={styles.note}>{group.note}</span>}
              </button>
              {!editing ? (
                <div style={styles.actions}>
                  <button
                    type="button"
                    aria-label={`编辑${pdfTextMarkupKindLabel(group.kind)}批注`}
                    style={styles.action}
                    onClick={() => {
                      setEditingGroupId(group.groupId)
                      setNoteDraft(group.note)
                    }}
                  >
                    {group.note.length > 0 ? '编辑备注' : '添加备注'}
                  </button>
                  <button
                    type="button"
                    aria-label={`删除${pdfTextMarkupKindLabel(group.kind)}批注`}
                    style={{ ...styles.action, ...styles.deleteAction }}
                    onClick={() => { props.onRemove(group.groupId) }}
                  >
                    删除
                  </button>
                </div>
              ) : (
                <div style={styles.editor}>
                  <textarea
                    autoFocus
                    aria-label="批注中心备注"
                    maxLength={MAX_PDF_ANNOTATION_NOTE_LENGTH}
                    value={noteDraft}
                    style={styles.textarea}
                    onChange={(event) => { setNoteDraft(event.target.value) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.stopPropagation()
                        setEditingGroupId(undefined)
                      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault()
                        props.onNoteChange(group.groupId, noteDraft)
                        setEditingGroupId(undefined)
                      }
                    }}
                  />
                  <div style={styles.editorFooter}>
                    <span style={styles.count}>{String(noteDraft.length)} / {String(MAX_PDF_ANNOTATION_NOTE_LENGTH)}</span>
                    <span style={styles.editorActions}>
                      <button type="button" style={styles.action} onClick={() => { setEditingGroupId(undefined) }}>取消</button>
                      <button
                        type="button"
                        style={{ ...styles.action, ...styles.saveAction }}
                        onClick={() => {
                          props.onNoteChange(group.groupId, noteDraft)
                          setEditingGroupId(undefined)
                        }}
                      >
                        保存
                      </button>
                    </span>
                  </div>
                </div>
              )}
            </article>
          )
        })}
        {renderedGroups.length < visibleGroups.length && (
          <button
            type="button"
            data-pdf-annotation-load-more="true"
            style={styles.loadMore}
            onClick={() => { setVisibleLimit(limit => limit + ANNOTATION_LIST_BATCH) }}
          >
            继续显示 {String(Math.min(ANNOTATION_LIST_BATCH, visibleGroups.length - renderedGroups.length))} 条
          </button>
        )}
      </div>
    </aside>
  )
}
