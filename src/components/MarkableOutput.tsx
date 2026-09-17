import { useEffect, useMemo, useRef, useState } from 'react'
import {
  activatesEntry,
  addMark,
  holdsFixShortcut,
  markButton,
  markCounts,
  markLabel,
  markSegments,
  removeMark,
} from '../lib/ui'
import type { Mark, MarkKind } from '../lib/ui'

interface Props {
  /** The rewrite. `pre.output` holds exactly this text, marks or not. */
  text: string
  marks: Mark[]
  onMarksChange: (marks: Mark[]) => void
  /** The refine gate (see canRefine): a mark, a model, and nothing in flight. */
  canRefine: boolean
  /** True while the request in flight is a refine, so the spinner sits where the user clicked. */
  refining: boolean
  onRefine: () => void
}

interface Offsets {
  start: number
  end: number
}

/**
 * The selection as character offsets into the pre's text, or null when there
 * is none or any selected text lies outside the pre. Offsets are measured by
 * stringifying a range from the start of the pre, which stays right when the
 * pre already holds <mark> children. A backwards drag needs no care here:
 * getRangeAt() always runs from the earlier boundary to the later one.
 */
function readSelection(pre: HTMLElement | null): Offsets | null {
  const sel = document.getSelection()
  if (!pre || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  if (!pre.contains(range.startContainer)) return null
  if (!pre.contains(range.endContainer)) {
    // A triple click parks the end boundary at the start of whatever follows
    // the block. That still selects nothing but the pre, so it counts; an end
    // that reaches real text outside does not.
    const tail = document.createRange()
    tail.selectNodeContents(pre)
    tail.collapse(false)
    tail.setEnd(range.endContainer, range.endOffset)
    if (tail.toString()) return null
  }
  const lead = document.createRange()
  lead.selectNodeContents(pre)
  lead.setEnd(range.startContainer, range.startOffset)
  const start = lead.toString().length
  const end = start + range.toString().length
  return end > start ? { start, end } : null
}

/**
 * Runs `restore` once, when the press that is just starting ends. Not every
 * press ends in a mouseup: dragging text that is already selected ends in a
 * dragend, and a button released outside a window that lost the focus on the
 * way is never reported at all.
 */
function whenPressEnds(restore: () => void) {
  const ended = new AbortController()
  const end = () => {
    ended.abort()
    restore()
  }
  document.addEventListener('mouseup', end, { signal: ended.signal })
  document.addEventListener('dragend', end, { signal: ended.signal })
  window.addEventListener('blur', end, { signal: ended.signal })
}

export function MarkableOutput({ text, marks, onMarksChange, canRefine, refining, onRefine }: Props) {
  const preRef = useRef<HTMLPreElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const [selection, setSelection] = useState<Offsets | null>(null)
  // Set when a mark is removed from the keyboard, or all of them by Clear marks:
  // the focused element is about to unmount, and focus must not fall back to
  // the top of the page.
  const refocus = useRef<number | null>(null)

  // Where focus goes when the control that held it is about to unmount or to be
  // disabled. The pre is tall and usually scrolled: focusing it must not drag
  // the pane back to its top. It shows no ring (see .output:focus).
  const focusRewrite = () => preRef.current?.focus({ preventScroll: true })

  useEffect(() => {
    const onSelection = () => {
      const next = readSelection(preRef.current)
      // selectionchange fires on every pixel of a drag; keep the state object while nothing moved.
      setSelection((prev) => (prev?.start === next?.start && prev?.end === next?.end ? prev : next))
    }
    document.addEventListener('selectionchange', onSelection)
    // Also on a new text or new marks: swapping the text nodes does not reliably
    // fire the event, and a selection standing after the marks that Clear marks or
    // a keyboard removal takes away collapses without one, leaving both buttons live.
    onSelection()
    return () => document.removeEventListener('selectionchange', onSelection)
  }, [text, marks])

  useEffect(() => {
    if (refocus.current === null) return
    const left = preRef.current?.querySelectorAll<HTMLElement>('mark') ?? []
    const next = left[Math.min(refocus.current, left.length - 1)]
    refocus.current = null
    if (next) next.focus()
    else focusRewrite()
  }, [marks])

  const segments = useMemo(() => markSegments(text, marks), [text, marks])
  const counts = markCounts(marks)

  const mark = (kind: MarkKind) => {
    // Read the live selection rather than the state: it cannot be a render behind.
    const range = readSelection(preRef.current)
    if (!range) return
    const next = addMark(marks, { ...range, kind }, text)
    // Only whitespace was selected (or the kind is full): nothing to mark, and the selection is left alone.
    if (next === marks) return
    onMarksChange(next)
    document.getSelection()?.removeAllRanges()
    setSelection(null)
  }

  const unmark = (index: number) => onMarksChange(removeMark(marks, index))

  const clearMarks = () => {
    // The button goes away with the last mark.
    refocus.current = 0
    onMarksChange([])
  }

  // The button is disabled for as long as the request runs, and gone once the
  // new rewrite (which has no marks) arrives: either way the browser would drop
  // the focus to <body>. Handed to the pre first, it sits on the marked rewrite
  // in flight, on the new one after, and next to the retry if the request fails.
  const refine = () => {
    focusRewrite()
    onRefine()
  }

  // Without this the press itself collapses the selection the button is about to read.
  const keepSelection = (e: React.MouseEvent) => e.preventDefault()

  // Chromium loses a drag that starts on the first character of a focusable
  // inline element with text before it on the line: the caret lands just
  // outside it, and focusing the element then clears the selection. Re-selecting
  // a marked passage to flip its verdict starts exactly there (a mark at the
  // start of a line is spared, so M7 drags one in mid-line). A mark only needs
  // focus from the keyboard, so for the length of a press it is not focusable
  // and the pre takes the focus instead.
  const unfocusableWhilePressed = (e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget
    el.removeAttribute('tabindex')
    whenPressEnds(() => el.setAttribute('tabindex', '0'))
  }

  // The bar is sticky, so a drag that starts in a long rewrite and moves up
  // runs onto it. Hit-testing then lands in the bar's labels, which precede the
  // pre in the document: the selection balloons to everything in between and
  // both buttons go dead. For the length of a press that began in the rewrite
  // (one on a highlight bubbles up here too) the bar is transparent to the
  // pointer, and the drag selects the text that scrolled underneath it.
  const barYieldsWhilePressed = (e: React.MouseEvent) => {
    const bar = barRef.current
    // Only the primary button drags a selection; the others open menus that can swallow the release.
    if (!bar || e.button !== 0) return
    bar.style.pointerEvents = 'none'
    whenPressEnds(() => bar.style.removeProperty('pointer-events'))
  }

  // Ctrl+Enter is the app-wide "fix from scratch" shortcut, and a fresh fix
  // throws the marks away: while there are marks to lose, the key stays inside
  // the marking UI. With none it bubbles to the app-wide handler as it always has.
  const holdShortcut = (e: React.KeyboardEvent) => {
    if (holdsFixShortcut(e, marks)) e.stopPropagation()
  }

  // Decided by the reducer's own rule for the selection at hand: a full kind
  // still takes a selection that redraws or merges marks of its own.
  const keepButton = markButton(marks, selection, 'keep', text)
  const changeButton = markButton(marks, selection, 'change', text)

  return (
    <>
      <div
        className="feedback-bar"
        data-testid="feedback-bar"
        ref={barRef}
        role="toolbar"
        aria-label="Mark the rewrite"
        onKeyDown={holdShortcut}
      >
        <span className="feedback-hint">Select a passage, then:</span>
        <button
          type="button"
          className="btn sm"
          disabled={keepButton.disabled}
          title={keepButton.title}
          onMouseDown={keepSelection}
          onClick={() => mark('keep')}
        >
          <i className="mark-swatch for-keep" aria-hidden="true" />
          Keep it — I loved it
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={changeButton.disabled}
          title={changeButton.title}
          onMouseDown={keepSelection}
          onClick={() => mark('change')}
        >
          <i className="mark-swatch for-change" aria-hidden="true" />
          Change it — I didn't like it
        </button>

        {marks.length > 0 && (
          <div className="feedback-marks">
            <span className="feedback-count" aria-live="polite">
              <span className="n-keep">{counts.keep} kept</span>
              {' · '}
              <span className="n-change">{counts.change} to change</span>
            </span>
            <button type="button" className="btn ghost sm" onClick={clearMarks}>
              Clear marks
            </button>
            <button type="button" className="btn primary sm" onClick={refine} disabled={!canRefine}>
              {refining && <span className="spinner" />}
              Fix again with my marks
            </button>
          </div>
        )}
      </div>

      {/* Nothing but the prompt text may live in here: tests and Copy rely on it. */}
      <pre
        className="output"
        data-testid="rewrite"
        ref={preRef}
        tabIndex={-1}
        onMouseDown={barYieldsWhilePressed}
        onKeyDown={holdShortcut}
      >
        {segments.map((seg, i) =>
          seg.kind ? (
            <mark
              key={i}
              className={`mark ${seg.kind}`}
              role="button"
              tabIndex={0}
              aria-label={markLabel(seg.kind, seg.text)}
              title="Click to remove this mark"
              onMouseDown={unfocusableWhilePressed}
              onClick={() => {
                // A drag that starts and ends inside one mark is a selection, not a click.
                if (document.getSelection()?.isCollapsed === false) return
                unmark(seg.index)
              }}
              onKeyDown={(e) => {
                if (!activatesEntry(e) || e.ctrlKey || e.metaKey || e.altKey) return
                // Space would scroll the pane.
                e.preventDefault()
                refocus.current = seg.index
                unmark(seg.index)
              }}
            >
              {seg.text}
            </mark>
          ) : (
            seg.text
          )
        )}
      </pre>
    </>
  )
}
