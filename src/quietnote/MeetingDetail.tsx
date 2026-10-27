import { Component, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Capture, LiveTranscript } from './Capture';
import { Icon } from './Icon';
import { Hush, HushYield } from './Hush';
import { SuggestPanel, type Summarizer } from './Suggestions';
import { serviceName } from './catalog';
import { desktop, device, openLink, transcriptData, type CaptureState, type Connections, type Service, type TranscriptTurn } from './storage';
import { actionItems, appendAction, clock, dateLabel, durationLabel, enhancedNotes, openingTab, section, statusLabel, summaryBlocks, timeLabel, transcriptTurns, yoursFirst, type ActionItem, type Meeting, type MeetingTab } from './model';
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
 * its open action items (ticking one ticks it in that meeting). */
function LastTime({ meeting, me, onToggle, onOpen }: { meeting: Meeting; me: string; onToggle: (index: number) => Promise<void>; onOpen: () => void }) {
  const { metadata: meta, markdown } = meeting;
  // A ticked item stays, struck through, until the meeting is left (as on Home); its toast can undo it.
  const [ticked, setTicked] = useState<string[]>([]);
  const open = yoursFirst(actionItems(markdown).filter(a => !a.done || ticked.includes(a.key)), a => a.owner, me);
  return <details className="last-time" open>
    <summary><Icon name="recent" size={15} />Last time<span className="subtle">{meta.title} · {dateLabel(meta.date)}</span></summary>
    {open.length > 0 && <div className="action-list">{open.map(a => <label className={`action-row ${a.done ? 'complete' : ''}`} key={a.key}>
      <input type="checkbox" checked={a.done} onChange={() => { setTicked(t => t.includes(a.key) ? t : [...t, a.key]); void onToggle(a.index); }} />
      <span><span className="action-text">{a.text}</span>{a.owner && <span className="action-owner">{a.owner}</span>}</span></label>)}</div>}
    <button className="text-button" onClick={onOpen}>Open {meta.title}<Icon name="arrow" size={14} /></button>
  </details>;
}
/** An action item in its meeting: tick it, press its text to edit it (Enter saves, Escape keeps it), or remove it. */
function ActionRow({ item, fresh, onToggle, onEdit, onRemove }: { item: ActionItem; fresh: boolean; onToggle: () => void; onEdit: (text: string) => void; onRemove: () => void }) {
  const [value, setValue] = useState<string | null>(null);
  const editing = useRef(false);
  const begin = () => { editing.current = true; setValue(item.text); };
  const end = (keep: boolean) => { if (!editing.current) return; editing.current = false; const next = value?.trim(); setValue(null); if (keep && next && next !== item.text) onEdit(next); };
  return <div className={`action-row ${item.done ? 'complete' : ''} ${fresh ? 'fresh' : ''}`}>
    <input type="checkbox" aria-label={item.text} checked={item.done} onChange={onToggle} />
    <span className="action-body">{value === null ? <button className="action-edit" title="Edit" onClick={begin}><span className="action-text">{item.text}</span></button>
      : <input className="action-input" aria-label="Edit action item" value={value} maxLength={300} autoFocus onChange={e => setValue(e.target.value)} onBlur={() => end(true)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.preventDefault(); end(false); } }} />}
      {item.owner && <span className="action-owner">{item.owner}</span>}</span>
    {item.link && <button className="action-link" title={item.link.url} onClick={() => void openLink(item.link!.url)}>{item.link.label}</button>}
    <button className="icon-button small action-remove" aria-label={`Remove “${item.text}”`} title="Remove" onClick={onRemove}><Icon name="close" size={14} /></button>
  </div>;
}
function AddItem({ label, onAdd }: { label: string; onAdd: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  return <form className="add-item" onSubmit={e => { e.preventDefault(); if (text.trim()) void onAdd(text).then(() => setText('')); }}>
    <Icon name="plus" size={15} /><input aria-label={label} placeholder={label} value={text} maxLength={300} onChange={e => setText(e.target.value)} />
    {text.trim() && <button type="submit" className="text-button">Add</button>}
  </form>;
}
/** Copies the whole transcript as shown (Clean or Verbatim, never filtered by Find) to paste into another app. */
function CopyTranscript({ title, turns, voices }: { title: string; turns: { time: string; speaker: string; text: string }[]; voices: number }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const text = `${title}\n\n${turns.map(t => `[${t.time}] ${voices > 1 ? `${t.speaker}: ` : ''}${t.text}`).join('\n')}\n`;
    try { if (desktop) await writeText(text); else await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { setCopied(false); }
  }
  // Both faces share one cell and crossfade through a slight blur; the hidden one is left out of the button's name.
  return <button className="text-button swap" onClick={() => void copy()}>
    <span aria-hidden={copied}><Icon name="copy" size={15} />Copy transcript</span>
    <span aria-hidden={!copied}><Icon name="check" size={15} />Copied</span>
  </button>;
}
export function MeetingDetail({ meeting, me, onRename, onSpeaker, previous, onPrevious, onToggle, onEdit, onRemove, onOpenPrevious, example, connections, live, cleanDefault, summarizer, template, tab, find = '', armed, onTab, onMarkdown, onNotes, onDraft, onUpdated, onStartCapture, onCloseCapture, onRetry, onExportAudio, onMarkEnded, onDismissRecovered, onSend, onDelete }: {
  meeting: Meeting; me: string; onRename: (title: string) => Promise<void>; onSpeaker: (from: string, to: string) => Promise<void>; previous: Meeting | null; onPrevious: (index: number) => Promise<void>; onToggle: (index: number) => Promise<void>; onEdit: (index: number, text: string) => Promise<void>; onRemove: (index: number) => Promise<void>; onOpenPrevious: () => void; example: boolean; connections: Connections; live: CaptureState; cleanDefault: boolean; summarizer: Summarizer | null; template?: string; tab: MeetingTab; find?: string; onTab: (tab: MeetingTab) => void; onSend: () => void; onMarkdown: (markdown: string) => Promise<void>; onNotes: (notes: string) => Promise<void>; onDraft: (notes: string) => void;
  armed: boolean | 'call'; onUpdated: (meeting: Meeting) => void; onStartCapture: () => void; onCloseCapture: () => void; onRetry: () => void; onExportAudio: () => void; onMarkEnded: () => void; onDismissRecovered: () => void; onDelete: () => void;
}) {
  const { metadata: meta, markdown, transcript } = meeting;
  // One Hush per screen: a notice's Hush (transcribing, a problem) or a drafting one comes before an empty state's,
  // which rests only when nothing is happening.
  const yielded = useContext(HushYield);
  const [drafting, setDrafting] = useState(false);
  const [fresh, setFresh] = useState<number | null>(null);
  const calm = meta.status !== 'recording' && !drafting;
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
  const notes = enhancedNotes(markdown);
  // Yours first, for showing only: each item is still written by its place in the file.
  const actions = yoursFirst(actionItems(markdown), a => a.owner, me);
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
  // Two tabs: Notes shows the enhanced notes or your own, and comes back to whichever was shown last.
  const [notesView, setNotesView] = useState<MeetingTab>(tab === 'Transcript' ? openingTab(meeting) : tab);
  if (tab !== 'Transcript' && tab !== notesView) setNotesView(tab);
  const shownTab = tab === 'Transcript' ? 'Transcript' : 'Notes';
  const tabIds = (t: string) => ({ tab: `tab-${t}`, panel: `panel-${t}` });
  const renderAction = (a: ActionItem) => <ActionRow key={a.key} item={a} fresh={a.index === fresh} onToggle={() => void onToggle(a.index)} onEdit={text => void onEdit(a.index, text)} onRemove={() => void onRemove(a.index)} />;
  // Rust owns a meeting while it records, waits to be transcribed or is transcribed, so it can't be deleted then.
  const owned = meta.status === 'recording' || meta.status === 'processing' || live.queued.includes(meta.id);
  const docked = armed || live.recording?.meetingId === meta.id || (!live.available && meta.status === 'recording');
  return <article className={`meeting-detail ${docked ? 'docked' : ''}`}>
    <header className="meeting-header">
      <div className="meeting-title-row">
        <div className="meeting-title">
          <h1><Title title={meta.title} editable={meta.status !== 'recording' && meta.status !== 'processing'} onRename={onRename} />{example && <span className="badge example">Example</span>}</h1>
          <p className="meeting-meta"><span>{meta.project}</span><span>{dateLabel(meta.date)}, {timeLabel(meta.date)}</span>{duration && <span>{duration}</span>}{status && <span className={`status ${paused ? 'paused' : meta.status}`}><i aria-hidden="true" />{status}</span>}{meta.participants.length > 0 && <Participants names={meta.participants} />}</p>
        </div>
        <div className="meeting-actions">
          {meta.status === 'idle' && !armed && <button className={live.available ? 'primary' : 'secondary'} disabled={Boolean(other)} title={other ? `“${other.title}” is recording. Stop it first.` : undefined} onClick={onStartCapture}>{live.available ? <><i className="record-dot" aria-hidden="true" />Start recording</> : 'Start capture'}</button>}
          {recorded && !armed && <button className="secondary" disabled={Boolean(other)} title={other ? `“${other.title}” is recording. Stop it first.` : 'Record more of this meeting. The new part is added to its transcript.'} onClick={onStartCapture}><i className="record-dot" aria-hidden="true" />Resume recording</button>}
          {!armed && <button className="icon-button" aria-label="Delete meeting" disabled={owned} title={owned ? (meta.status === 'recording' ? 'Stop recording before deleting this meeting.' : 'Wait until it’s transcribed to delete it.') : 'Delete meeting'} onClick={onDelete}><Icon name="trash" size={16} /></button>}
        </div>
      </div>
      <div className="meeting-tabs" role="tablist" aria-label="Meeting sections" onKeyDown={e => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const next = shownTab === 'Notes' ? 'Transcript' : 'Notes';
        onTab(next === 'Notes' ? notesView : next); document.getElementById(tabIds(next).tab)?.focus();
      }}>{(['Notes', 'Transcript'] as const).map(t => <button key={t} id={tabIds(t).tab} role="tab" aria-selected={t === shownTab} aria-controls={tabIds(t).panel} tabIndex={t === shownTab ? 0 : -1} onClick={() => onTab(t === 'Notes' ? notesView : t)}>{t}</button>)}</div>
    </header>
    {meta.status === 'idle' && other && !armed && <p className="subtle start-hint">“{other.title}” is recording. Stop it before recording this meeting.</p>}
    {meta.interrupted ? <div className={`notice ${meta.status === 'error' ? 'attention' : ''}`} role="status">{meta.status === 'ready' ? <Icon name="info" size={16} /> : <Hush mood={meta.status === 'processing' ? 'transcribing' : 'attention'} size={44} fallback={<Icon name="info" size={16} />} />}<div>
        <strong>Recovered recording</strong>
        <p>QuietNote closed before this recording was stopped. The audio{endedAt && ` up to ${endedAt}`} was saved. {meta.status === 'processing' ? transcribing : meta.status === 'ready' ? 'Its transcript is ready.' : 'Transcription couldn’t finish. Your recording is still saved.'}</p>
        {meta.status === 'error' && details}
      </div><div className="notice-actions">{meta.status === 'error' && audioKept && <button className="text-button" onClick={onRetry}>Retry transcription</button>}{meta.status !== 'processing' && <button className="text-button" onClick={onDismissRecovered}>Dismiss</button>}</div></div>
    : meta.status === 'processing' ? <div className="notice" role="status"><Hush mood="transcribing" size={44} progress={live.transcribing?.meetingId === meta.id ? live.transcribing.percent / 100 : undefined} fallback={<Icon name="recent" size={16} />} /><div><strong>{transcribing}</strong><p>This runs on this {device}. You can keep working or close the window. The audio is kept until the transcript is saved.</p></div></div>
    : meta.status === 'error' && audioKept ? <div className="notice attention" role="status"><Hush mood="attention" size={44} fallback={<Icon name="info" size={16} />} /><div><strong>Transcription couldn’t finish.</strong><p>Your recording is still saved{meta.duration > 0 ? ` (${durationLabel(meta.duration)})` : ''}, so you can retry.</p>{details}</div><div className="notice-actions"><button className="text-button" onClick={onExportAudio}>Export audio…</button><button className="text-button" onClick={onRetry}>Retry transcription</button></div></div>
    : meta.status === 'error' && <div className="notice attention" role="status"><Hush mood="attention" size={44} fallback={<Icon name="info" size={16} />} /><div><strong>This meeting was interrupted before it finished.</strong><p>{meta.error ?? (live.available ? 'QuietNote closed while it was recording, and no audio was saved.' : 'QuietNote closed while capture was running. No audio was recorded.')} Anything you wrote in Notes is kept.</p></div><div className="notice-actions"><button className="text-button" onClick={() => onTab('Notes')}>Add notes</button><button className="text-button" onClick={onMarkEnded}>Mark as ended</button></div></div>}
    <HushYield.Provider value={yielded || meta.status === 'processing' || meta.status === 'error'}><div className="meeting-content" role="tabpanel" id={tabIds(shownTab).panel} aria-labelledby={tabIds(shownTab).tab}>
      {shownTab === 'Notes' && <div className="segmented notes-view" role="group" aria-label="Notes view"><button aria-pressed={tab === 'Enhanced'} onClick={() => onTab('Enhanced')}>Enhanced notes</button><button aria-pressed={tab === 'Notes'} onClick={() => onTab('Notes')}>My notes</button></div>}
      {tab === 'Enhanced' && (() => {
        // As in Granola, the action items lead the enhanced notes once there are some; until then, adding one is at the end.
        const todo = <section className="note-actions" aria-labelledby="note-actions">
          <div className="note-actions-head"><h3 id="note-actions">Action items</h3>
            {canSend && <button className="text-button send-button" onClick={onSend}><Icon name="arrow" size={15} />{services.length === 1 ? `Send to ${serviceName(services[0])}…` : 'Send to…'}</button>}</div>
          {actions.length > 0 && <div className="action-list">{actions.map(renderAction)}</div>}
          <AddItem label="Add an action item" onAdd={text => onMarkdown(appendAction(markdown, text))} />
        </section>;
        return <>
          {recorded && summarizer && <SuggestPanel meeting={meeting} summarizer={summarizer} template={template} onWorking={setDrafting} onAdded={setFresh} onMarkdown={onMarkdown} onRename={onRename} onSpeaker={onSpeaker} onCite={atMs => cite(clock(atMs / 1000))} />}
          {actions.length > 0 && todo}
          {notes ? <div className="summary-text">{actions.length > 0 && summaryBlocks(notes)[0].kind !== 'heading' && <h3>Summary</h3>}{summaryBlocks(notes).map((b, i) => b.kind === 'heading' ? <h3 key={i}>{b.text}</h3> : b.kind === 'paragraph' ? <p key={i}>{b.text}</p>
            // A point with a transcript time was added from the transcript; the rest came from the notes.
            : <ul key={i}>{b.items.map((item, j) => <li key={j} className={item.at ? 'added' : undefined}>{item.text}{item.at && <> <button className="citation" title="Show this line in the transcript" onClick={() => cite(item.at!)}><span className="timestamp">{item.at}</span></button></>}</li>)}</ul>)}</div>
          : <div className="empty-inline">{calm && <Hush mood="resting" size={72} />}<h2>No enhanced notes yet.</h2><p>{!live.available || example ? 'Enhancing notes isn’t available in this version. Your own notes are the record of this meeting.' : summarizer ? recorded ? 'Enhance your notes from the transcript, or ask for suggestions from it.' : 'Once it’s recorded, you can enhance your notes from its transcript.' : 'Turn on summary suggestions in Settings → Privacy to enhance your notes from the transcript.'}</p><button className="secondary" onClick={() => onTab('Notes')}>Open my notes</button></div>}
          {!actions.length && todo}
        </>;
      })()}
      {tab === 'Notes' && previous && (meta.status === 'idle' || meta.status === 'recording') && <LastTime meeting={previous} me={me} onToggle={onPrevious} onOpen={onOpenPrevious} />}
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
            <CopyTranscript title={meta.title} turns={turns} voices={voices} />
            {recorded && meta.audioPath && <button className="text-button" onClick={onExportAudio}><Icon name="folder" size={15} />Export audio…</button>}
            <label className="inline-search"><Icon name="search" size={15} /><input placeholder="Find in transcript" aria-label="Find in transcript" value={transcriptQuery} onChange={e => setTranscriptQuery(e.target.value)} /></label></div>
          {raw && <p className="subtle transcript-caption">Clean removes simple filler words and repeated stutters. Verbatim keeps the original transcription.</p>}
          {shownTurns.map((t, i) => <div className="transcript-turn" data-time={t.time} key={i}><h3>{voices > 1 && t.speaker !== shownTurns[i - 1]?.speaker && (canName ? <button className="speaker-name" title={`Name ${t.speaker}`} onClick={() => setNaming({ from: t.speaker, to: '', error: '' })}>{t.speaker}</button> : <span>{t.speaker}</span>)}<span className="timestamp">{t.time}</span></h3><p>{t.text}</p></div>)}
          {!shownTurns.length && <p className="subtle">Nothing in the transcript matches “{transcriptQuery}”.</p>}
        </>}
        {live.available && !example ? (() => {
          const waiting = turns.length ? null : <div className="empty-inline">{calm && <Hush mood="resting" size={72} />}<h2>{meta.status === 'processing' ? 'Transcribing…' : raw ? 'No speech was recognized.' : 'No transcript yet.'}</h2><p>{meta.status === 'idle' ? `Start recording and QuietNote transcribes the meeting on this ${device} when you stop.` : meta.status === 'processing' || meta.status === 'recording' ? 'The transcript appears here when it’s ready.' : 'Your notes are the record of this meeting.'}</p></div>;
          // While recording, and until the full transcript is ready, the live draft stands in for it (after
          // the earlier transcript, when recording was resumed).
          const here = live.recording?.meetingId === meta.id ? live.recording : null;
          if (!live.liveTranscript || !(here ? here.liveText !== 'off' : meta.status === 'processing')) return waiting;
          return <LiveTranscript meetingId={meta.id} clean={!verbatim} state={here?.liveText ?? 'on'} empty={here ? undefined : waiting}
            caption={here ? `Live draft, transcribed on this ${device}. The full transcript is made when you stop.` : 'Live draft. The full transcript replaces it when it’s ready.'} />;
        })()
        : !turns.length && <div className="empty-inline"><Hush mood="resting" size={72} /><h2>Transcript unavailable.</h2><p>This version doesn’t transcribe audio.</p></div>}
      </section>}
    </div></HushYield.Provider>
    {docked && <Capture meeting={meeting} autoStart={armed} live={live} clean={cleanDefault} transcript={tab !== 'Transcript'} onUpdated={onUpdated} onClose={onCloseCapture} />}
  </article>;
}
