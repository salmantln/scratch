import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Capture, LiveTranscript } from './Capture';
import { Icon } from './Icon';
import { SuggestPanel, type Summarizer } from './Suggestions';
import { serviceName } from './catalog';
import { device, openLink, revealAudio, transcriptData, type CaptureState, type Connections, type Service, type TranscriptTurn } from './storage';
import { actionItems, appendItem, clock, dateLabel, decisions, durationLabel, meetingTabs, section, statusLabel, summaryBlocks, timeLabel, toggleAction, transcriptTurns, type Meeting, type MeetingTab } from './model';
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
// Participants as initials in overlapping circles, each a different tint; the full names are on hover.
const initials = (name: string) => { const words = name.trim().split(/\s+/); return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase(); };
function Participants({ names }: { names: string[] }) {
  const shown = names.length > 5 ? names.slice(0, 4) : names;
  return <span className="participants" role="img" aria-label={`Participants: ${names.join(', ')}`} title={names.join(', ')}>
    {shown.map((name, i) => <i key={name} className={`avatar tone-${i % 4}`} title={name}>{initials(name)}</i>)}
    {shown.length < names.length && <i className="avatar more">+{names.length - shown.length}</i>}
  </span>;
}
/** The meeting's title; where it can change, pressing it edits it (Enter saves, Escape keeps it). */
function Title({ title, editable, onRename }: { title: string; editable: boolean; onRename: (title: string) => Promise<void> }) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState('');
  if (value === null) return editable ? <button className="title-edit" title="Rename this meeting" onClick={() => { setValue(title); setError(''); }}>{title}</button> : <>{title}</>;
  const save = () => { const next = value.trim(); if (!next || next === title) { setValue(null); return; } onRename(next).then(() => setValue(null)).catch(e => setError(`Couldn’t rename it. ${String(e).replace(/^Error: /, '')}`)); };
  return <form className="title-form" onSubmit={e => { e.preventDefault(); save(); }}>
    <input aria-label="Meeting title" value={value} maxLength={160} autoFocus onChange={e => setValue(e.target.value)} onBlur={save} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setValue(null); } }} />
    {error && <span className="field-error" role="alert">{error}</span>}
  </form>;
}
/** What the meeting before this one left open, above the notes while this one is about to happen or recording:
 * its open action items (ticking one ticks it in that meeting) and its decisions. */
function LastTime({ meeting, onMarkdown, onOpen }: { meeting: Meeting; onMarkdown: (markdown: string) => Promise<void>; onOpen: () => void }) {
  const { metadata: meta, markdown } = meeting;
  const agreed = decisions(markdown);
  // A ticked item stays, struck through, until the meeting is left (as on Home).
  const [ticked, setTicked] = useState<number[]>([]);
  const open = actionItems(markdown).filter(a => !a.done || ticked.includes(a.index));
  return <details className="last-time" open>
    <summary><Icon name="recent" size={15} />Last time<span className="subtle">{meta.title} · {dateLabel(meta.date)}</span></summary>
    {open.length > 0 && <div className="action-list">{open.map(a => <label className={`action-row ${ticked.includes(a.index) ? 'complete' : ''}`} key={a.index}>
      <input type="checkbox" checked={ticked.includes(a.index)} disabled={ticked.includes(a.index)} onChange={() => { setTicked(t => [...t, a.index]); void onMarkdown(toggleAction(markdown, a.index)).catch(() => setTicked(t => t.filter(i => i !== a.index))); }} />
      <span><span className="action-text">{a.text}</span>{a.owner && <span className="action-owner">{a.owner}</span>}</span></label>)}</div>}
    {agreed.length > 0 && <ul className="decision-list">{agreed.slice(0, 3).map((d, i) => <li key={i}><Icon name="decision" size={16} />{d}</li>)}</ul>}
    <button className="text-button" onClick={onOpen}>Open {meta.title}<Icon name="arrow" size={14} /></button>
  </details>;
}
function AddItem({ label, onAdd }: { label: string; onAdd: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  return <form className="add-item" onSubmit={e => { e.preventDefault(); if (text.trim()) void onAdd(text).then(() => setText('')); }}>
    <Icon name="plus" size={15} /><input aria-label={label} placeholder={label} value={text} maxLength={300} onChange={e => setText(e.target.value)} />
    {text.trim() && <button type="submit" className="text-button">Add</button>}
  </form>;
}
export function MeetingDetail({ meeting, onRename, onSpeaker, previous, onPrevious, onOpenPrevious, example, connections, live, cleanDefault, summarizer, template, tab, find = '', armed, onTab, onMarkdown, onNotes, onDraft, onUpdated, onStartCapture, onCloseCapture, onRetry, onMarkEnded, onDismissRecovered, onSend }: {
  meeting: Meeting; onRename: (title: string) => Promise<void>; onSpeaker: (from: string, to: string) => Promise<void>; previous: Meeting | null; onPrevious: (markdown: string) => Promise<void>; onOpenPrevious: () => void; example: boolean; connections: Connections; live: CaptureState; cleanDefault: boolean; summarizer: Summarizer | null; template?: string; tab: MeetingTab; find?: string; onTab: (tab: MeetingTab) => void; onSend: () => void; onMarkdown: (markdown: string) => Promise<void>; onNotes: (notes: string) => Promise<void>; onDraft: (notes: string) => void;
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
  // A suggestion's citation opens the Transcript tab at the line it quotes.
  const [cited, setCited] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== 'Transcript' || !cited) return;
    // After the window scrolls back to the top for the new tab.
    const timer = window.setTimeout(() => {
      const turn = document.querySelector<HTMLElement>(`.transcript-turn[data-time="${cited}"]`);
      if (!turn) return;
      turn.scrollIntoView({ block: 'center' }); turn.classList.add('cited');
      setCited(null);
    }, 50);
    return () => clearTimeout(timer);
  }, [tab, cited, raw]);
  const cite = (at: string) => { setTranscriptQuery(''); setCited(at); onTab('Transcript'); };
  // Naming a voice in a recorded transcript: by hand (press its label), or the one other person invited.
  const canName = Boolean(raw) && !example && meta.status === 'ready';
  const [naming, setNaming] = useState<{ from: string; to: string; error: string } | null>(null);
  const [inviteDismissed, setInviteDismissed] = useState(false);
  const invitedOthers = (meta.attendees ?? []).filter(a => !a.me).map(a => a.name);
  const unnamedVoices = [...new Set((raw ?? []).map(t => t.speaker))].filter(v => v !== 'You');
  const inviteGuess = canName && !inviteDismissed && invitedOthers.length === 1 && unnamedVoices.length === 1 && /^(Others|Speaker \d+)$/.test(unnamedVoices[0]) ? { from: unnamedVoices[0], to: invitedOthers[0] } : null;
  const nameVoice = (from: string, to: string) => onSpeaker(from, to).then(() => setNaming(null)).catch(e => setNaming({ from, to, error: String(e).replace(/^Error: /, '') }));
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
  // Who's speaking is only worth saying when it changes, and not at all when only one side spoke.
  const voices = new Set(turns.map(t => t.speaker)).size;
  const paused = live.recording?.meetingId === meta.id && live.recording.resumedAt === null;
  const status = paused ? 'Paused' : statusLabel(meta.status);
  const duration = durationLabel(meta.duration);
  const tabIds = (t: MeetingTab) => ({ tab: `tab-${t.replace(' ', '-')}`, panel: `panel-${t.replace(' ', '-')}` });
  const renderAction = (a: typeof actions[number]) => <label className={`action-row ${a.done ? 'complete' : ''}`} key={a.index}>
    <input type="checkbox" checked={a.done} onChange={() => void onMarkdown(toggleAction(markdown, a.index))} />
    <span><span className="action-text">{a.text}</span>{a.owner && <span className="action-owner">{a.owner}</span>}</span>
    {a.link && <button className="action-link" title={a.link.url} onClick={e => { e.preventDefault(); void openLink(a.link!.url); }}>{a.link.label}</button>}
  </label>;
  const docked = armed || live.recording?.meetingId === meta.id || (!live.available && meta.status === 'recording');
  return <article className={`meeting-detail ${docked ? 'docked' : ''}`}>
    <header className="meeting-header">
      <div className="meeting-title-row">
        <div className="meeting-title">
          <h1><Title title={meta.title} editable={meta.status !== 'recording' && meta.status !== 'processing'} onRename={onRename} />{example && <span className="badge example">Example</span>}</h1>
          <p className="meeting-meta"><span>{meta.project}</span><span>{dateLabel(meta.date)}, {timeLabel(meta.date)}</span>{duration && <span>{duration}</span>}{status && <span className={`status ${paused ? 'paused' : meta.status}`}><i aria-hidden="true" />{status}</span>}{meta.participants.length > 0 && <Participants names={meta.participants} />}</p>
        </div>
        {meta.status === 'idle' && !armed && <button className={live.available ? 'primary' : 'secondary'} disabled={Boolean(other)} title={other ? `“${other.title}” is recording. Stop it first.` : undefined} onClick={onStartCapture}>{live.available ? <><i className="record-dot" aria-hidden="true" />Start recording</> : 'Start capture'}</button>}
        {recorded && !armed && <button className="secondary" disabled={Boolean(other)} title={other ? `“${other.title}” is recording. Stop it first.` : 'Record more of this meeting. The new part is added to its transcript.'} onClick={onStartCapture}><i className="record-dot" aria-hidden="true" />Resume recording</button>}
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
        {recorded && summarizer && <SuggestPanel meeting={meeting} summarizer={summarizer} template={template} onMarkdown={onMarkdown} onRename={onRename} onSpeaker={onSpeaker} onCite={atMs => cite(clock(atMs / 1000))} />}
        {summary ? <div className="summary-text">{summaryBlocks(summary).map((b, i) => b.kind === 'heading' ? <h3 key={i}>{b.text}</h3> : b.kind === 'paragraph' ? <p key={i}>{b.text}</p>
          // A point with a transcript time was added from the transcript; the rest came from the notes.
          : <ul key={i}>{b.items.map((item, j) => <li key={j} className={item.at ? 'added' : undefined}>{item.text}{item.at && <> <button className="citation" title="Show this line in the transcript" onClick={() => cite(item.at!)}><span className="timestamp">{item.at}</span></button></>}</li>)}</ul>)}</div> : <div className="empty-inline"><h2>No summary yet.</h2><p>{!live.available || example ? 'Automatic summaries aren’t available in this version. Your own notes are the record of this meeting.' : summarizer ? recorded ? 'Suggest one from the transcript, or write your own.' : 'Your own notes are the record of this meeting. Once it’s recorded, you can ask for suggestions from its transcript.' : 'Write your own, or turn on summary suggestions in Settings → Privacy to draft one from the transcript.'}</p><button className="secondary" onClick={() => onTab('Notes')}>Add notes</button></div>}
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
      {tab === 'Notes' && previous && (meta.status === 'idle' || meta.status === 'recording') && <LastTime meeting={previous} onMarkdown={onPrevious} onOpen={onOpenPrevious} />}
      {tab === 'Notes' && <div className="quiet-editor"><NotesBoundary><Suspense fallback={<p className="subtle">Opening notes…</p>}><Editor onDraftChange={onDraft} key={meta.id} previewMode={{ content: section(markdown, 'Notes'), title: 'Notes', filePath: meta.meetingPath, modified: 0, hasExternalChanges: false, reloadVersion: 0, save, reload: async () => {} }} /></Suspense></NotesBoundary></div>}
      {tab === 'Transcript' && <section>
        {inviteGuess && <div className="notice" role="status"><Icon name="people" size={16} /><div><strong>Is “{inviteGuess.from}” {inviteGuess.to}?</strong><p>{inviteGuess.to} was the only other person invited.</p></div>
          <div className="notice-actions"><button className="text-button" onClick={() => setInviteDismissed(true)}>Not now</button><button className="text-button" onClick={() => void nameVoice(inviteGuess.from, inviteGuess.to)}>Name them</button></div></div>}
        {naming && <form className="name-speaker" onSubmit={e => { e.preventDefault(); if (naming.to.trim()) void nameVoice(naming.from, naming.to); }}>
          <label>Name “{naming.from}” <input aria-label={`Name for ${naming.from}`} list="invited-names" value={naming.to} maxLength={60} autoFocus onChange={e => setNaming({ ...naming, to: e.target.value, error: '' })} /></label>
          <datalist id="invited-names">{invitedOthers.map(n => <option key={n} value={n} />)}</datalist>
          <button type="submit" className="text-button" disabled={!naming.to.trim()}>Save</button><button type="button" className="text-button" onClick={() => setNaming(null)}>Cancel</button>
          {naming.error && <span className="field-error" role="alert">{naming.error}</span>}
          <p className="subtle">Every line by {naming.from} gets this name; the words stay as they were recognized. A name another voice has merges the two.</p>
        </form>}
        {turns.length > 0 && <>
          <div className="transcript-tools">{example && <span className="subtle">Example transcript · illustrative, not a recording</span>}
            {raw && <div className="segmented" role="group" aria-label="Transcript view"><button aria-pressed={!verbatim} onClick={() => setVerbatim(false)}>Clean</button><button aria-pressed={verbatim} onClick={() => setVerbatim(true)}>Verbatim</button></div>}
            {recorded && meta.audioPath && <button className="text-button" onClick={() => void revealAudio(meta)}><Icon name="open" size={15} />Show audio</button>}
            <label className="inline-search"><Icon name="search" size={15} /><input placeholder="Find in transcript" aria-label="Find in transcript" value={transcriptQuery} onChange={e => setTranscriptQuery(e.target.value)} /></label></div>
          {raw && <p className="subtle transcript-caption">Clean removes simple filler words and repeated stutters. Verbatim keeps the original transcription.</p>}
          {shownTurns.map((t, i) => <div className="transcript-turn" data-time={t.time} key={i}><h3>{voices > 1 && t.speaker !== shownTurns[i - 1]?.speaker && (canName ? <button className="speaker-name" title={`Name ${t.speaker}`} onClick={() => setNaming({ from: t.speaker, to: '', error: '' })}>{t.speaker}</button> : <span>{t.speaker}</span>)}<span className="timestamp">{t.time}</span></h3><p>{t.text}</p></div>)}
          {!shownTurns.length && <p className="subtle">Nothing in the transcript matches “{transcriptQuery}”.</p>}
        </>}
        {live.available && !example ? (() => {
          const waiting = turns.length ? null : <div className="empty-inline"><h2>{meta.status === 'processing' ? 'Transcribing…' : raw ? 'No speech was recognized.' : 'No transcript yet.'}</h2><p>{meta.status === 'idle' ? `Start recording and QuietNote transcribes the meeting on this ${device} when you stop.` : meta.status === 'processing' || meta.status === 'recording' ? 'The transcript appears here when it’s ready.' : 'Your notes are the record of this meeting.'}</p></div>;
          // While recording, and until the full transcript is ready, the live draft stands in for it (after
          // the earlier transcript, when recording was resumed).
          const here = live.recording?.meetingId === meta.id ? live.recording : null;
          if (!live.liveTranscript || !(here ? here.liveText !== 'off' : meta.status === 'processing')) return waiting;
          return <LiveTranscript meetingId={meta.id} clean={!verbatim} state={here?.liveText ?? 'on'} empty={here ? undefined : waiting}
            caption={here ? `Live draft, transcribed on this ${device}. The full transcript is made when you stop.` : 'Live draft. The full transcript replaces it when it’s ready.'} />;
        })()
        : !turns.length && <div className="empty-inline"><h2>Transcript unavailable.</h2><p>This version doesn’t transcribe audio.</p></div>}
      </section>}
    </div>
    {docked && <Capture meeting={meeting} autoStart={armed} live={live} clean={cleanDefault} transcript={tab !== 'Transcript'} onUpdated={onUpdated} onClose={onCloseCapture} />}
  </article>;
}
