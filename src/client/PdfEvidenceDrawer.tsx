import { useState } from 'react'
import type { CSSProperties } from 'react'
import { MAX_PDF_AI_QUESTION_CODE_UNITS, formatPdfReferencePages } from './composer-pdf-reference.ts'
import type { PdfMixedAiAction } from './composer-pdf-mixed.ts'
import type { PdfEvidenceImage } from './PdfViewer.tsx'
import type { PdfTextEvidence } from './pdf-evidence.ts'

const styles = {
  drawer: {
    position: 'absolute', zIndex: 15, top: '12px', bottom: '12px', left: '12px',
    display: 'flex', flexDirection: 'column', width: '320px', maxWidth: 'calc(100% - 24px)',
    overflow: 'hidden', border: '1px solid rgba(0,0,0,0.14)', borderRadius: '12px',
    background: 'rgba(255,255,255,0.98)', color: '#262626',
    boxShadow: '0 8px 28px rgba(0,0,0,0.22)', backdropFilter: 'blur(10px)',
  },
  header: { display: 'flex', alignItems: 'center', minHeight: '42px', padding: '0 8px 0 13px', borderBottom: '1px solid #ececec' },
  title: { fontSize: '13px', fontWeight: 650 },
  count: { marginLeft: '7px', color: '#888', fontSize: '10px' },
  close: { marginLeft: 'auto', width: '28px', height: '28px', padding: 0, border: 'none', borderRadius: '7px', background: 'transparent', color: '#595959', cursor: 'pointer', fontSize: '19px' },
  scope: { display: 'flex', alignItems: 'center', gap: '5px', minHeight: '32px', padding: '0 8px 0 13px', borderBottom: '1px solid #f0f0f0', background: '#fafbff' },
  scopeCount: { color: '#52618f', fontSize: '10px', fontWeight: 600 },
  scopeActions: { display: 'flex', gap: '3px', marginLeft: 'auto' },
  scopeButton: { height: '23px', padding: '0 6px', border: 'none', borderRadius: '5px', background: 'transparent', color: '#5870cc', cursor: 'pointer', fontFamily: 'inherit', fontSize: '10px' },
  aiArea: { position: 'relative', padding: '8px', borderBottom: '1px solid #f0f0f0' },
  aiButton: { width: '100%', height: '32px', border: 'none', borderRadius: '8px', background: 'rgba(77,107,254,0.11)', color: '#3154d8', cursor: 'pointer', fontFamily: 'inherit', fontSize: '11px', fontWeight: 650 },
  disabled: { cursor: 'default', opacity: 0.45 },
  aiHint: { marginTop: '5px', color: '#8a8a8a', fontSize: '10px', lineHeight: '15px' },
  aiMenu: { position: 'absolute', zIndex: 3, top: '46px', left: '8px', right: '8px', padding: '5px', border: '1px solid rgba(0,0,0,0.12)', borderRadius: '10px', background: '#fff', boxShadow: '0 7px 22px rgba(0,0,0,0.2)' },
  aiMenuItem: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', gap: '2px', padding: '8px 9px', border: 'none', borderRadius: '7px', background: 'transparent', color: '#303034', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  aiMenuLabel: { fontSize: '12px', fontWeight: 650, lineHeight: '16px' },
  aiMenuHint: { color: '#83838a', fontSize: '10px', lineHeight: '14px' },
  question: { padding: '4px' },
  questionTitle: { marginBottom: '6px', color: '#555', fontSize: '11px' },
  textarea: { display: 'block', width: '100%', minHeight: '76px', padding: '7px 8px', resize: 'vertical', border: '1px solid #d8d8d8', borderRadius: '8px', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: '12px', lineHeight: '17px' },
  questionFooter: { display: 'flex', alignItems: 'center', marginTop: '5px' },
  questionCount: { color: '#999', fontSize: '10px' },
  questionActions: { display: 'flex', gap: '4px', marginLeft: 'auto' },
  action: { height: '25px', padding: '0 8px', border: 'none', borderRadius: '6px', background: 'transparent', color: '#696969', cursor: 'pointer', fontFamily: 'inherit', fontSize: '10px' },
  send: { background: '#4d6bfe', color: '#fff' },
  error: { marginTop: '6px', color: '#c23b32', fontSize: '10px', lineHeight: '15px' },
  list: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '7px 8px 12px' },
  section: { padding: '5px 7px', color: '#888', fontSize: '10px', fontWeight: 650 },
  item: { display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '5px', padding: '6px', border: '1px solid #ededed', borderRadius: '9px', background: '#fff' },
  itemExcluded: { background: '#fafafa', opacity: 0.62 },
  checkbox: { flex: '0 0 auto', width: '14px', height: '14px', margin: 0, accentColor: '#4d6bfe', cursor: 'pointer' },
  navigate: { display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0, padding: 0, border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  thumbnail: { flex: '0 0 auto', width: '48px', height: '40px', objectFit: 'cover', border: '1px solid #ddd', borderRadius: '6px', background: '#f5f5f5' },
  itemBody: { minWidth: 0, flex: 1 },
  itemMeta: { color: '#777', fontSize: '10px', lineHeight: '14px' },
  excerpt: { display: '-webkit-box', marginTop: '3px', overflow: 'hidden', color: '#333', fontSize: '11px', lineHeight: '16px', overflowWrap: 'anywhere', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 },
  remove: { flex: '0 0 auto', width: '25px', height: '25px', padding: 0, border: 'none', borderRadius: '6px', background: 'transparent', color: '#999', cursor: 'pointer', fontSize: '15px' },
  footer: { display: 'flex', justifyContent: 'flex-end', padding: '8px', borderTop: '1px solid #eee' },
  clear: { height: '27px', padding: '0 8px', border: 'none', borderRadius: '6px', background: 'transparent', color: '#b9473f', cursor: 'pointer', fontFamily: 'inherit', fontSize: '10px' },
} satisfies Record<string, CSSProperties>

export function PdfEvidenceDrawer(props: {
  images: readonly PdfEvidenceImage[]
  texts: readonly PdfTextEvidence[]
  selectedImages: readonly PdfEvidenceImage[]
  selectedTexts: readonly PdfTextEvidence[]
  onImageSelectedChange: (selection: PdfEvidenceImage, selected: boolean) => void
  onTextSelectedChange: (id: string, selected: boolean) => void
  onSelectAll: () => void
  onDeselectAll: () => void
  onNavigateImage: (selection: PdfEvidenceImage) => void
  onRemoveImage: (selection: PdfEvidenceImage) => void
  onNavigateText: (source: PdfTextEvidence) => void
  onRemoveText: (id: string) => void
  onClear: () => void
  onAiRequest: (action: PdfMixedAiAction, images: readonly PdfEvidenceImage[], texts: readonly PdfTextEvidence[], question?: string) => Promise<void>
  onClose: () => void
}) {
  const [aiMenuOpen, setAiMenuOpen] = useState(false)
  const [questionOpen, setQuestionOpen] = useState(false)
  const [questionDraft, setQuestionDraft] = useState('')
  const [busy, setBusy] = useState<PdfMixedAiAction | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const ready = props.selectedImages.length > 0 && props.selectedTexts.length > 0
  const allSelected = props.selectedImages.length === props.images.length
    && props.selectedTexts.length === props.texts.length
  const noneSelected = props.selectedImages.length === 0 && props.selectedTexts.length === 0

  const submit = (action: PdfMixedAiAction, question?: string): void => {
    if (busy !== undefined || !ready) return
    const imageBatch = [...props.selectedImages]
    const textBatch = [...props.selectedTexts]
    setError(undefined)
    setBusy(action)
    void props.onAiRequest(action, imageBatch, textBatch, question).then(() => {
      setAiMenuOpen(false)
      setQuestionOpen(false)
      setQuestionDraft('')
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { setBusy(undefined) })
  }

  return (
    <aside data-pdf-evidence-drawer="true" aria-label="图文资料" style={styles.drawer}>
      <div style={styles.header}>
        <span style={styles.title}>图文资料</span>
        <span style={styles.count}>共 图 {String(props.images.length)} · 文 {String(props.texts.length)}</span>
        <button type="button" aria-label="关闭图文资料" title="关闭" style={styles.close} onClick={props.onClose}>×</button>
      </div>
      <div data-pdf-evidence-scope="true" style={styles.scope}>
        <span style={styles.scopeCount}>本次参与：图 {String(props.selectedImages.length)} / {String(props.images.length)} · 文 {String(props.selectedTexts.length)} / {String(props.texts.length)}</span>
        <span style={styles.scopeActions}>
          <button type="button" data-pdf-evidence-select-all="true" disabled={allSelected} style={{ ...styles.scopeButton, ...(allSelected ? styles.disabled : {}) }} onClick={props.onSelectAll}>全选</button>
          <button type="button" data-pdf-evidence-select-none="true" disabled={noneSelected} style={{ ...styles.scopeButton, ...(noneSelected ? styles.disabled : {}) }} onClick={props.onDeselectAll}>取消全选</button>
        </span>
      </div>
      <div style={styles.aiArea}>
        <button
          type="button"
          data-pdf-evidence-ai-button="true"
          disabled={!ready || busy !== undefined}
          style={{ ...styles.aiButton, ...(!ready ? styles.disabled : {}) }}
          onClick={() => { setAiMenuOpen(open => !open); setQuestionOpen(false); setError(undefined) }}
        >
          ✦ AI 分析已选资料
        </button>
        {!ready && <div style={styles.aiHint}>本次提问至少选择 1 张图片和 1 段文字</div>}
        {aiMenuOpen && (
          <div data-pdf-evidence-ai-menu="true" role="menu" aria-label="图文资料 AI 操作" style={styles.aiMenu}>
            {!questionOpen ? (
              <>
                {([
                  ['explain', '综合解释', '结合已选图片和文字资料说明概念'],
                  ['relate', '分析对应关系', '逐项对应已选文字与图片中的部分'],
                  ['verify', '核对一致性', '检查已选资料的支持、矛盾和遗漏'],
                  ['question', '深入提问…', '围绕当前已选图文资料提出问题'],
                ] as const).map(([action, label, hint]) => (
                  <button
                    key={action}
                    type="button"
                    role="menuitem"
                    data-pdf-evidence-ai-action={action}
                    disabled={busy !== undefined}
                    style={styles.aiMenuItem}
                    onClick={() => {
                      if (action === 'question') setQuestionOpen(true)
                      else submit(action)
                    }}
                  >
                    <span style={styles.aiMenuLabel}>{label}</span>
                    <span style={styles.aiMenuHint}>{hint}</span>
                  </button>
                ))}
              </>
            ) : (
              <form style={styles.question} onSubmit={(event) => { event.preventDefault(); submit('question', questionDraft) }}>
                <div style={styles.questionTitle}>围绕当前已选图文资料提问</div>
                <textarea
                  autoFocus
                  aria-label="图文资料问题"
                  maxLength={MAX_PDF_AI_QUESTION_CODE_UNITS}
                  value={questionDraft}
                  placeholder="例如：这些段落分别补充了图中的哪些信息？"
                  style={styles.textarea}
                  onChange={(event) => { setQuestionDraft(event.target.value) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') { event.preventDefault(); setQuestionOpen(false) }
                    else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit('question', questionDraft) }
                  }}
                />
                <div style={styles.questionFooter}>
                  <span style={styles.questionCount}>{String(questionDraft.length)} / {String(MAX_PDF_AI_QUESTION_CODE_UNITS)}</span>
                  <span style={styles.questionActions}>
                    <button type="button" style={styles.action} onClick={() => { setQuestionOpen(false) }}>返回</button>
                    <button type="submit" disabled={busy !== undefined || questionDraft.trim().length === 0} style={{ ...styles.action, ...styles.send }}>
                      {busy === 'question' ? '发送中…' : '发送'}
                    </button>
                  </span>
                </div>
              </form>
            )}
            {error !== undefined && <div role="alert" style={styles.error}>{error}</div>}
          </div>
        )}
      </div>
      <div style={styles.list}>
        {props.images.length > 0 && <div style={styles.section}>图片</div>}
        {props.images.map((image, index) => {
          const selected = props.selectedImages.includes(image)
          const requestIndex = selected ? props.selectedImages.indexOf(image) + 1 : undefined
          return (
            <div key={`image:${String(index)}`} data-pdf-evidence-image="true" data-pdf-evidence-selected={selected ? 'true' : 'false'} style={{ ...styles.item, ...(!selected ? styles.itemExcluded : {}) }}>
              <input
                type="checkbox"
                checked={selected}
                aria-label={`本次提问使用图片资料 ${String(index + 1)}`}
                style={styles.checkbox}
                onChange={(event) => { props.onImageSelectedChange(image, event.target.checked) }}
              />
              <button type="button" style={styles.navigate} onClick={() => { props.onNavigateImage(image) }}>
                <img alt="" src={`data:image/png;base64,${image.pngBase64}`} style={styles.thumbnail} />
                <span style={styles.itemBody}>
                  <span style={styles.itemMeta}>图片 {String(index + 1)} · {selected ? `本次图 ${String(requestIndex)}` : '未参与'} · {image.documentName} · 第 {String(image.pageNumber)} 页</span>
                </span>
              </button>
              <button type="button" aria-label={`删除图片资料 ${String(index + 1)}`} style={styles.remove} onClick={() => { props.onRemoveImage(image) }}>×</button>
            </div>
          )
        })}
        {props.texts.length > 0 && <div style={styles.section}>文字</div>}
        {props.texts.map((source, index) => {
          const pages = [...new Set(source.drafts.map(draft => draft.pageNumber))]
          const selected = props.selectedTexts.some(candidate => candidate.id === source.id)
          const requestIndex = selected ? props.selectedTexts.findIndex(candidate => candidate.id === source.id) + 1 : undefined
          return (
            <div key={source.id} data-pdf-evidence-text="true" data-pdf-evidence-selected={selected ? 'true' : 'false'} style={{ ...styles.item, ...(!selected ? styles.itemExcluded : {}) }}>
              <input
                type="checkbox"
                checked={selected}
                aria-label={`本次提问使用文字资料 ${String(index + 1)}`}
                style={styles.checkbox}
                onChange={(event) => { props.onTextSelectedChange(source.id, event.target.checked) }}
              />
              <button type="button" style={styles.navigate} onClick={() => { props.onNavigateText(source) }}>
                <span style={styles.itemBody}>
                  <span style={styles.itemMeta}>文字 {String(index + 1)} · {selected ? `本次文 ${String(requestIndex)}` : '未参与'} · {source.documentName} · {formatPdfReferencePages(pages)}</span>
                  <span style={styles.excerpt}>{source.text}</span>
                </span>
              </button>
              <button type="button" aria-label={`删除文字资料 ${String(index + 1)}`} style={styles.remove} onClick={() => { props.onRemoveText(source.id) }}>×</button>
            </div>
          )
        })}
      </div>
      <div style={styles.footer}>
        <button type="button" data-pdf-evidence-clear="true" style={styles.clear} onClick={props.onClear}>清空全部资料</button>
      </div>
    </aside>
  )
}
