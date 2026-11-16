import type { ComponentType } from 'react'
import {
  parseStructuredAnswerText as parseStructuredAnswer,
  type StructuredAnswer
} from '../../shared/structuredAnswer'

export interface SessionSummary {
  name: string
  title: string
  company: string
  endedAt: string | null
  segments: number
  answers: number
}

export interface SessionData {
  title?: string
  company?: string
  endedAt?: string
  segments?: Array<{ id?: string; speaker: string; text: string; ts: number }>
  answers?: Array<{
    text: string
    error?: string
    question?: string
    anchorId?: string
    images?: string[]
  }>
}

export interface HistoryViewProps {
  detail: SessionData | null
  sessions: SessionSummary[]
  loading: boolean
  pendingDelete: string | null
  pendingDeleteAll: boolean
  /** Loads one saved session into the detail pane. */
  onOpen: (name: string) => void
  onCloseDetail: () => void
  onBackHome: () => void
  onDelete: (name: string) => void
  onExport: (name: string) => void
  onDeleteAll: () => void
  /** Shared structured-answer renderer (also used by the live thread). */
  AnswerCard: ComponentType<{ card: StructuredAnswer }>
}

export default function HistoryView({
  detail,
  sessions,
  loading,
  pendingDelete,
  pendingDeleteAll,
  onOpen,
  onCloseDetail,
  onBackHome,
  onDelete,
  onExport,
  onDeleteAll,
  AnswerCard
}: HistoryViewProps) {
  return (
    <div className="history">
      {detail ? (
        <>
          <div className="row gap history-head">
            <button className="btn tiny" onClick={onCloseDetail}>
              Back
            </button>
            <strong>{detail.title ?? 'Session'}</strong>
            <span className="hint small">
              {detail.endedAt ? new Date(detail.endedAt).toLocaleString() : ''}
            </span>
          </div>
          <div className="scroll">
            {(() => {
              const segments = detail.segments ?? []
              const answerList = detail.answers ?? []
              const byAnchor = new Map<string, typeof answerList>()
              const loose: typeof answerList = []
              for (const answer of answerList) {
                if (answer.anchorId) {
                  const list = byAnchor.get(answer.anchorId) ?? []
                  list.push(answer)
                  byAnchor.set(answer.anchorId, list)
                } else {
                  loose.push(answer)
                }
              }
              const items: Array<
                | { kind: 'seg'; key: string; speaker: string; text: string }
                | {
                    kind: 'ans'
                    key: string
                    text: string
                    images?: string[]
                    card?: StructuredAnswer
                  }
              > = []
              const answerItem = (answer: (typeof answerList)[number], key: string) => ({
                kind: 'ans' as const,
                key,
                text: answer.text || answer.error || '',
                images: answer.images,
                card: answer.error
                  ? undefined
                  : parseStructuredAnswer(answer.text ?? '') ?? undefined
              })
              segments.forEach((segment, index) => {
                items.push({
                  kind: 'seg',
                  key: `s${index}`,
                  speaker: segment.speaker,
                  text: segment.text
                })
                if (!segment.id) return
                const anchored = byAnchor.get(segment.id)
                if (anchored) {
                  anchored.forEach((answer, answerIndex) =>
                    items.push(answerItem(answer, `s${index}a${answerIndex}`))
                  )
                  byAnchor.delete(segment.id)
                }
              })
              let extra = 0
              for (const list of byAnchor.values()) {
                for (const answer of list) {
                  items.push(answerItem(answer, `x${extra++}`))
                }
              }
              for (const answer of loose) {
                items.push(answerItem(answer, `l${extra++}`))
              }
              return items.map((item) =>
                item.kind === 'seg' ? (
                  <div key={item.key} className="seg">
                    <span className={`speaker ${item.speaker === 'You' ? 'you' : 'them'}`}>
                      {item.speaker}
                    </span>
                    <span className="seg-text">{item.text}</span>
                  </div>
                ) : (
                  <div key={item.key} className="answer">
                    <div className="answer-head">
                      <span className="speaker answer-tag">Answer</span>
                      {item.card && <span className="answer-kind">coded</span>}
                    </div>
                    {item.card ? (
                      <AnswerCard card={item.card} />
                    ) : (
                      <div className="answer-text">{item.text}</div>
                    )}
                    {item.images && item.images.length > 0 && (
                      <div className="attachments history-images">
                        {item.images.map((url, imageIndex) => (
                          <img
                            key={imageIndex}
                            className="thumb"
                            src={url}
                            alt={`Screenshot ${imageIndex + 1}`}
                            title="Screenshot"
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              )
            })()}
          </div>
        </>
      ) : (
        <>
          <div className="row gap history-head">
            <button className="btn tiny" onClick={onBackHome}>
              Back
            </button>
            <strong>Session history</strong>
            {sessions.length > 0 && (
              <button
                className="btn tiny danger"
                style={{ marginLeft: 'auto' }}
                onClick={onDeleteAll}
              >
                {pendingDeleteAll ? 'Confirm delete all' : 'Delete all'}
              </button>
            )}
          </div>
          <div className="scroll">
            {loading && <div className="empty">Loading…</div>}
            {!loading && sessions.length === 0 && (
              <div className="empty">No saved sessions yet. End a session to save it.</div>
            )}
            {sessions.map((session) => (
              <div key={session.name} className="history-row">
                <button className="history-item" onClick={() => onOpen(session.name)}>
                  <div className="history-title">{session.title}</div>
                  <div className="hint small">
                    {session.endedAt
                      ? new Date(session.endedAt).toLocaleString()
                      : 'unknown date'}{' '}
                    · {session.segments} transcript · {session.answers} answers
                  </div>
                </button>
                <button
                  className="btn tiny"
                  title="Export this session as Markdown"
                  onClick={() => onExport(session.name)}
                >
                  Export
                </button>
                <button
                  className="btn tiny danger"
                  title="Delete this session"
                  onClick={() => onDelete(session.name)}
                >
                  {pendingDelete === session.name ? 'Confirm' : 'Delete'}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
