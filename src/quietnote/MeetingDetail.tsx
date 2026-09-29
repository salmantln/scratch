import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Capture } from './Capture';
import { Icon } from './Icon';
import { serviceName } from './catalog';
import { device, openLink, revealAudio, transcriptData, type CaptureState, type Connections, type Service, type TranscriptTurn } from './storage';
import { actionItems, appendItem, clock, dateLabel, decisions, durationLabel, meetingTabs, section, statusLabel, timeLabel, toggleAction, transcriptTurns, type Meeting, type MeetingTab } from './model';
const Editor = lazy(() => import('../components/editor/Editor').then(module => ({ default: module.Editor })));
/** A failure in the notes editor stays in the Notes tab instead of blanking the window. A failed import is cached
 * by the webview, so recovering means reloading; drafts and the open tab are restored. */
class NotesBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('Notes couldn’t open.', error); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <div className="empty-inline" role="alert"><h2>Notes couldn’t open.</h2><p>Your saved notes are unchanged in the meeting file.</p>
      <button className="secondary" onClick={() => location.reload()}>Reload</button>
      <details className="advanced"><summary>Details</summary><p className="path">{error.stack ?? String(error)}</p></details></div>;
  }
}
function AddItem({ label, onAdd }: { label: string; onAdd: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  return <form className="add-item" onSubmit={e => { e.preventDefault(); if (text.trim()) void onAdd(text).then(() => setText('')); }}>
    <Icon name="plus" size={15} /><input aria-label={label} placeholder={label} value={text} maxLength={300} onChange={e => setText(e.target.value)} />
    {text.trim() && <button type="submit" className="text-button">Add</button>}
  </form>;
}
export function MeetingDetail({ meeting, example, connections, live, cleanDefault, tab, find = '', armed, onTab, onMarkdown, onNotes, onDraft, onUpdated, onStartCapture, onCloseCapture, onRetry, onMarkEnded, onDismissRecovered, onSend }: {
  meeting: Meeting; example: boolean; connections: Connections; live: CaptureState; cleanDefault: boolean; tab: MeetingTab; find?: string; onTab: (tab: MeetingTab) => void; onSend: () => void; onMarkdown: (markdown: string) => Promise<void>; onNotes: (notes: string) => Promise<void>; onDraft: (notes: string) => void;
  armed: boolean; onUpdated: (meeting: Meeting) => void; onStartCapture: () => void; onCloseCapture: () => void; onRetry: () => void; onMarkEnded: () => void; onDismissRecovered: () => void;
}) {
  const { metadata: meta, markdown, transcript } = meeting;
  const [transcriptQuery, setTranscriptQuery] = useState(find);
  // Both views of a recorded transcript. Switching only changes what's shown; the raw words stay.
  const [verbatim, setVerbatim] = useState(!cleanDefault);
  const [raw, setRaw] = useState<TranscriptTurn[] | null>(null);
  const recorded = Boolean(live.available && !example && (meta.audioPath || meta.captureEndedAt) && meta.status === 'ready');
  useEffect(() => {
    if (!recorded || tab !== 'Transcript') return;
    let cancelled = false;
    transcriptData(meta.id).then(data => { if (!cancelled) setRaw(data); }).catch(() => { if (!cancelled) setRaw(null); });
    return () => { cancelled = true; };
  }, [recorded, tab, meta.id, transcript]);
  const latestSave = useRef(onNotes); latestSave.current = onNotes;
  const save = useCallback((notes: string) => latestSave.current(notes), []);
  const summary = section(markdown, 'Summary');
  const agreed = decisions(markdown);
  const actions = actionItems(markdown);
  const open = actions.filter(a => !a.done);
  const services = Object.keys(connections) as Service[];
  const canSend = !example && services.length > 0 && open.some(a => !a.link);
  const turns = raw ? raw.map(t => ({ time: clock(t.startMs / 1000), speaker: t.speaker, text: verbatim ? t.text : t.clean })).filter(t => t.text) : transcriptTurns(transcript);
  const other = live.recording && live.recording.meetingId !== meta.id ? live.recording : null;
  const job = live.transcribing?.meetingId === meta.id ? live.transcribing : null;
  const transcribing = job ? `Transcribing on this ${device}… ${job.percent}%` : 'Waiting to transcribe…';
  const audioKept = Boolean(meta.audioPath && live.available);
  const endedAt = meta.captureEndedAt ? timeLabel(meta.captureEndedAt) : '';
  const details = meta.error && <details><summary>Details</summary><p>{meta.error}</p></details>;
  const shownTurns = turns.filter(t => `${t.speaker} ${t.text}`.toLowerCase().includes(transcriptQuery.toLowerCase()));
  const status = statusLabel(meta.status);
  const duration = durationLabel(meta.duration);
  const tabIds = (t: MeetingTab) => ({ tab: `tab-${t.replace(' ', '-')}`, panel: `panel-${t.replace(' ', '-')}` });
  const renderAction = (a: typeof actions[number]) => <label className={`action-row ${a.done ? 'complete' : ''}`} key={a.index}>
    <input type="checkbox" checked={a.done} onChange={() => void onMarkdown(toggleAction(markdown, a.index))} />
    <span><span className="action-text">{a.text}</span>{a.owner && <span className="action-owner">{a.owner}</span>}</span>
    {a.link && <button className="action-link" title={a.link.url} onClick={e => { e.preventDefault(); void openLink(a.link!.url); }}>{a.link.label}</button>}
  </label>;
  return <article className="meeting-detail">
    <header className="meeting-header">
      <div className="meeting-title-row">
        <div className="meeting-title">
          <h1>{meta.title}{example && <span className="badge example">Example</span>}</h1>
          <p className="meeting-meta"><span>{meta.project}</span><span>{dateLabel(meta.date)}, {timeLabel(meta.date)}</span>{duration && <span>{duration}</span>}{status && <span className={`status ${meta.status}`}><i aria-hidden="true" />{status}</span>}{meta.participants.length > 0 && <span className="participants" title={meta.participants.join(', ')}>{meta.participants.join(', ')}</span>}</p>
        </div>
        {meta.status === 'idle' && !armed && <button className={live.available ? 'primary' : 'secondary'} disabled={Boolean(other)} title={other ? `“${other.title}” is recording. Stop it first.` : undefined} onClick={onStartCapture}>{live.available ? <><i className="record-dot" aria-hidden="true" />Start recording</> : 'Start capture'}</button>}
      </div>
      <div className="meeting-tabs" role="tablist" aria-label="Meeting sections" onKeyDown={e => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = meetingTabs[(meetingTabs.indexOf(tab) + step + meetingTabs.length) % meetingTabs.length];
        onTab(next); document.getElementById(tabIds(next).tab)?.focus();
      }}>{meetingTabs.map(t => <button key={t} id={tabIds(t).tab} role="tab" aria-selected={t === tab} aria-controls={tabIds(t).panel} tabIndex={t === tab ? 0 : -1} onClick={() => onTab(t)}>{t}{t === 'Action items' && open.length > 0 && <><span className="count" aria-hidden="true">{open.length}</span><span className="sr-only">, {open.length} open</span></>}</button>)}</div>
    </header>
    {meta.status === 'idle' && other && !armed && <p className="subtle start-hint">“{other.title}” is recording. Stop it before recording this meeting.</p>}
    {(armed || live.recording?.meetingId === meta.id || (!live.available && meta.status === 'recording')) && <Capture meeting={meeting} autoStart={armed} live={live} onUpdated={onUpdated} onClose={onCloseCapture} />}
    {meta.interrupted ? <div className={`notice ${meta.status === 'error' ? 'attention' : ''}`} role="status"><Icon name="info" size={16} /><div>
        <strong>Recovered recording</strong>
        <p>QuietNote closed before this recording was stopped. The audio{endedAt && ` up to ${endedAt}`} was saved. {meta.status === 'processing' ? transcribing : meta.status === 'ready' ? 'Its transcript is ready.' : 'Transcription couldn’t finish. Your recording is still saved.'}</p>
        {meta.status === 'error' && details}
      </div><div className="notice-actions">{meta.status === 'error' && audioKept && <button className="text-button" onClick={onRetry}>Retry transcription</button>}{meta.status !== 'processing' && <button className="text-button" onClick={onDismissRecovered}>Dismiss</button>}</div></div>
    : meta.status === 'processing' ? <div className="notice" role="status"><Icon name="recent" size={16} /><div><strong>{transcribing}</strong><p>This runs on this {device}. You can keep working or close the window. The audio is kept until the transcript is saved.</p></div></div>
    : meta.status === 'error' && audioKept ? <div className="notice attention" role="status"><Icon name="info" size={16} /><div><strong>Transcription couldn’t finish.</strong><p>Your recording is still saved{meta.duration > 0 ? ` (${durationLabel(meta.duration)})` : ''}, so you can retry.</p>{details}</div><div className="notice-actions"><button className="text-button" onClick={() => void revealAudio(meta)}>Show audio</button><button className="text-button" onClick={onRetry}>Retry transcription</button></div></div>
    : meta.status === 'error' && <div className="notice attention" role="status"><Icon name="info" size={16} /><div><strong>This meeting was interrupted before it finished.</strong><p>{meta.error ?? (live.available ? 'QuietNote closed while it was recording, and no audio was saved.' : 'QuietNote closed while capture was running. No audio was recorded.')} Anything you wrote in Notes is kept.</p></div><div className="notice-actions"><button className="text-button" onClick={() => onTab('Notes')}>Add notes</button><button className="text-button" onClick={onMarkEnded}>Mark as ended</button></div></div>}
    <div className="meeting-content" role="tabpanel" id={tabIds(tab).panel} aria-labelledby={tabIds(tab).tab}>
      {tab === 'Summary' && <>
        {summary ? <div className="summary-text">{summary.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div> : <div className="empty-inline"><h2>No summary yet.</h2><p>Automatic summaries aren’t available in this version. Your own notes are the record of this meeting.</p><button className="secondary" onClick={() => onTab('Notes')}>Add notes</button></div>}
        {agreed.length > 0 && <section className="summary-preview"><h2>Decisions</h2><ul className="decision-list">{agreed.slice(0, 3).map((d, i) => <li key={i}><Icon name="decision" size={16} />{d}</li>)}</ul>{agreed.length > 3 && <button className="text-button" onClick={() => onTab('Decisions')}>All {agreed.length} decisions<Icon name="arrow" size={14} /></button>}</section>}
        {actions.length > 0 && <section className="summary-preview"><h2>Action items</h2><button className="text-button" onClick={() => onTab('Action items')}>{open.length ? `${open.length} of ${actions.length} open` : `All ${actions.length} complete`}<Icon name="arrow" size={14} /></button></section>}
      </>}
      {tab === 'Decisions' && <section>
        {agreed.length ? <ul className="decision-list">{agreed.map((d, i) => <li key={i}><Icon name="decision" size={16} />{d}</li>)}</ul> : <div className="empty-inline"><h2>No decisions yet.</h2><p>Add what was agreed so it’s easy to find later.</p></div>}
        <AddItem label="Add a decision" onAdd={text => onMarkdown(appendItem(markdown, 'Decisions', text))} />
      </section>}
      {tab === 'Action items' && <section>
        {canSend && <div className="transcript-tools"><button className="text-button send-button" onClick={onSend}><Icon name="arrow" size={15} />{services.length === 1 ? `Send to ${serviceName(services[0])}…` : 'Send to…'}</button></div>}
        {actions.length ? <div className="action-list">{actions.map(renderAction)}</div> : <div className="empty-inline"><h2>No action items yet.</h2><p>Add follow-ups as you go. Write “Maya — send the plan” to note an owner.</p></div>}
        <AddItem label="Add an action item" onAdd={text => onMarkdown(appendItem(markdown, 'Action items', text))} />
      </section>}
      {tab === 'Notes' && <div className="quiet-editor"><NotesBoundary><Suspense fallback={<p className="subtle">Opening notes…</p>}><Editor onDraftChange={onDraft} key={meta.id} previewMode={{ content: section(markdown, 'Notes'), title: 'Notes', filePath: meta.meetingPath, modified: 0, hasExternalChanges: false, reloadVersion: 0, save, reload: async () => {} }} /></Suspense></NotesBoundary></div>}
      {tab === 'Transcript' && <section>
        {turns.length ? <>
          <div className="transcript-tools">{example && <span className="subtle">Example transcript · illustrative, not a recording</span>}
            {raw && <div className="segmented" role="group" aria-label="Transcript view"><button aria-pressed={!verbatim} onClick={() => setVerbatim(false)}>Clean</button><button aria-pressed={verbatim} onClick={() => setVerbatim(true)}>Verbatim</button></div>}
            {recorded && meta.audioPath && <button className="text-button" onClick={() => void revealAudio(meta)}><Icon name="open" size={15} />Show audio</button>}
            <label className="inline-search"><Icon name="search" size={15} /><input placeholder="Find in transcript" aria-label="Find in transcript" value={transcriptQuery} onChange={e => setTranscriptQuery(e.target.value)} /></label></div>
          {raw && <p className="subtle transcript-caption">Clean removes simple filler words and repeated stutters. Verbatim keeps the original transcription.</p>}
          {shownTurns.map((t, i) => <div className="transcript-turn" key={i}><h3>{t.speaker}<span className="timestamp">{t.time}</span></h3><p>{t.text}</p></div>)}
          {!shownTurns.length && <p className="subtle">Nothing in the transcript matches “{transcriptQuery}”.</p>}
        </> : live.available && !example ? <div className="empty-inline"><h2>{meta.status === 'processing' ? 'Transcribing…' : raw ? 'No speech was recognized.' : 'No transcript yet.'}</h2><p>{meta.status === 'idle' ? `Start recording and QuietNote transcribes the meeting on this ${device} when you stop.` : meta.status === 'processing' || meta.status === 'recording' ? 'The transcript appears here when it’s ready.' : 'Your notes are the record of this meeting.'}</p></div>
        : <div className="empty-inline"><h2>Transcript unavailable.</h2><p>This version doesn’t transcribe audio.</p></div>}
      </section>}
    </div>
  </article>;
}
