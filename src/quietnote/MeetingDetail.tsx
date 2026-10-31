import { Component, lazy, Suspense, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Capture, LiveTranscript, useListening } from './Capture';
import { Icon } from './Icon';
import { Hush, HushYield } from './Hush';
import { SuggestPanel, type Summarizer } from './Suggestions';
import { serviceName } from './catalog';
import { label } from './shortcuts';
import { desktop, device, openLink, transcriptData, type CaptureState, type Connections, type Service, type TranscriptTurn } from './storage';
import { actionItems, appendAction, clock, dateLabel, dueText, durationLabel, enhancedNotes, itemMeta, madeUp, section, statusLabel, summaryBlocks, timeLabel, transcriptTurns, yoursFirst, type ActionItem, type Meeting, type MeetingTab } from './model';
const Editor = lazy(() => import('../components/editor/Editor').then(module => ({ default: module.Editor })));
const demoSeen = 'quietnote.enhance-demo.v1';
/** An example, never this meeting's words: what highlighting your notes and enhancing them does. It plays once (about
 * 2.4 s) the first time it's shown; after that, and with Reduce Motion, it's the last frame. */
function EnhanceDemo() {
  const [play] = useState(() => { try { return !localStorage.getItem(demoSeen); } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(demoSeen, '1'); } catch { /* It plays again next time. */ } }, []);
  return <figure className={`enhance-demo ${play ? 'play' : ''}`} role="img" aria-label="Example: you highlight “SSO is the blocker” in your notes; enhancing adds “Okta isn’t set up, so it blocks week 1.” from 11:30 in the transcript and suggests “Ask legal for a review date”.">
    <figcaption>Example</figcaption>
    <ul><li>Pilot starts 3 Nov</li><li><mark>SSO is the blocker</mark></li><li className="added">Okta isn’t set up, so it blocks week 1. <span className="timestamp">11:30</span></li></ul>
    <div className="enhance-demo-action"><span>Ask legal for a review date</span><span className="enhance-demo-add">Add</span></div>
  </figure>;
}
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
// Participants by name in the meta line; past four, the rest are counted and all of them are on hover.
function Participants({ names }: { names: string[] }) {
  const shown = names.length > 5 ? names.slice(0, 4) : names;
  return <span className="participants" title={names.join(', ')}>{shown.join(', ')}{shown.length < names.length && ` +${names.length - shown.length}`}</span>;
}
/** The meeting's title; where it can change, pressing it edits it (Enter saves, Escape keeps it). */
function Title({ title, editable, onRename }: { title: string; editable: boolean; onRename: (title: string) => Promise<void> }) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState('');
  // A made-up name ("Zoom call", "Untitled meeting") rests in grey with its pencil showing, waiting to be named.
  if (value === null) return editable ? <button className={`title-edit ${madeUp(title) ? 'made-up' : ''}`} title="Rename this meeting" onClick={() => { setValue(title); setError(''); }}>{title}<Icon name="pencil" size={16} /></button> : <>{title}</>;
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
      <span><span className="action-text">{a.text}</span>{itemMeta(a) && <span className="action-owner">{itemMeta(a)}</span>}</span></label>)}</div>}
    <button className="text-button" onClick={onOpen}>Open {meta.title}<Icon name="arrow" size={14} /></button>
  </details>;
}
/** Edits one of an item's fields in place: Enter or leaving it saves, Escape keeps what was there. */
function useField(current: string, save: (value: string) => void) {
  const [value, setValue] = useState<string | null>(null);
  const editing = useRef(false);
  const begin = () => { editing.current = true; setValue(current); };
  const end = (keep: boolean) => { if (!editing.current) return; editing.current = false; const next = value?.trim() ?? ''; setValue(null); if (keep && next !== current) save(next); };
  const keys = (e: ReactKeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.preventDefault(); end(false); } };
  return { value, setValue, begin, end, keys };
}
/** An action item in its meeting: tick it, press its text, owner or due date to change it, or remove it.
 * The owner is typed, with the meeting's people suggested; an empty one is nobody yet. */
function ActionRow({ item, fresh, people, onToggle, onEdit, onOwner, onDue, onRemove }: { item: ActionItem; fresh: boolean; people: string[]; onToggle: () => void; onEdit: (text: string) => void; onOwner: (owner: string) => void; onDue: (due: string) => void; onRemove: () => void }) {
  const text = useField(item.text, next => { if (next) onEdit(next); });
  const owner = useField(item.owner, onOwner);
  const due = useField(item.due ?? '', onDue);
  const list = useId();
  return <div className={`action-row ${item.done ? 'complete' : ''} ${fresh ? 'fresh' : ''}`}>
    <input type="checkbox" aria-label={item.text} checked={item.done} onChange={onToggle} />
    <span className="action-body">{text.value === null ? <button className="action-edit" title="Edit" onClick={text.begin}><span className="action-text">{item.text}</span></button>
      : <input className="action-input" aria-label="Edit action item" value={text.value} maxLength={300} autoFocus onChange={e => text.setValue(e.target.value)} onBlur={() => text.end(true)} onKeyDown={text.keys} />}
      <span className="action-meta">
        {owner.value === null ? <button className={`action-field ${item.owner ? '' : 'unset'}`} aria-label={item.owner ? `Owner: ${item.owner}` : 'Assign an owner'} onClick={owner.begin}>{item.owner || 'Assign'}</button>
          : <><input className="action-input field" aria-label="Owner" placeholder="Nobody yet" list={list} value={owner.value} maxLength={80} autoFocus onChange={e => owner.setValue(e.target.value)} onBlur={() => owner.end(true)} onKeyDown={owner.keys} />
            <datalist id={list}>{people.map(p => <option key={p} value={p} />)}</datalist></>}
        {due.value === null ? <span className="action-due">
            <button className={`action-field ${item.due ? '' : 'unset'}`} onClick={due.begin}>{dueText(item) || 'Due date'}</button>
            {item.due && <button className="icon-button small action-clear" aria-label="Remove due date" title="Remove due date" onClick={() => onDue('')}><Icon name="close" size={12} /></button>}</span>
          : <input className="action-input field" type="date" aria-label="Due date" value={due.value} autoFocus onChange={e => due.setValue(e.target.value)} onBlur={() => due.end(true)} onKeyDown={due.keys} />}
      </span></span>
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
// Meetings whose Who spoke? was put off with Not now. A convenience only: losing it just asks again.
const skippedKey = 'quietnote.naming-skipped.v1';
const namingSkipped = (): string[] => { try { return JSON.parse(localStorage.getItem(skippedKey) ?? '[]'); } catch { return []; } };
const skipNaming = (id: string) => { try { localStorage.setItem(skippedKey, JSON.stringify([...namingSkipped(), id])); } catch { /* Asked again next time. */ } };
type Voice = { voice: string; time: string; line: string; guess: string };
const cut = (text: string) => text.length > 120 ? `${text.slice(0, 117).trimEnd()}…` : text;
/** The voices still to name, each with the first thing it said: "Speaker N", and "Others" only when one other person
 * was invited (whose name is suggested), since one "Others" can be several people. */
function unnamedVoices(turns: TranscriptTurn[], invited: string[]): Voice[] {
  const first = new Map<string, TranscriptTurn>();
  for (const t of turns) if (!first.has(t.speaker)) first.set(t.speaker, t);
  return [...first].filter(([voice]) => /^Speaker \d+$/.test(voice) || (voice === 'Others' && invited.length === 1))
    .map(([voice, t]) => ({ voice, time: clock(t.startMs / 1000), line: cut(t.clean || t.text), guess: voice === 'Others' ? invited[0] : '' }));
}
/** Once a transcript is ready, its unnamed voices, each with its first line, to name before anything else is offered. */
function WhoSpoke({ voices, invited, onName, onCite, onSkip }: { voices: Voice[]; invited: string[]; onName: (from: string, to: string) => Promise<void>; onCite: (at: string) => void; onSkip: () => void }) {
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(voices.map(v => [v.voice, v.guess])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const typed = voices.filter(v => names[v.voice]?.trim());
  async function save() {
    setSaving(true); setError('');
    // One at a time: each name rewrites the transcript.
    try { for (const v of typed) await onName(v.voice, names[v.voice].trim()); }
    catch (e) { setError(`Couldn’t save the names. ${String(e).replace(/^Error: /, '')}`); }
    finally { setSaving(false); }
  }
  return <form className="notice who-spoke" aria-labelledby="who-spoke" onSubmit={e => { e.preventDefault(); void save(); }}>
    <Icon name="people" size={16} />
    <div className="who-spoke-body">
      <strong id="who-spoke">Who spoke?</strong>
      <p>Each voice gets its name on every line; the words stay as they were recognized.</p>
      <ul>{voices.map(v => <li key={v.voice}>
        <label className="field">{v.voice}<input aria-label={`Who is ${v.voice}?`} list="who-spoke-names" value={names[v.voice] ?? ''} maxLength={60} placeholder="Name" onChange={e => setNames(n => ({ ...n, [v.voice]: e.target.value }))} /></label>
        <p className="who-line"><button type="button" className="citation" title="Show this line in the transcript" onClick={() => onCite(v.time)}><span className="timestamp">{v.time}</span></button> “{v.line}”</p>
      </li>)}</ul>
      <datalist id="who-spoke-names">{invited.map(n => <option key={n} value={n} />)}</datalist>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="button-row"><button type="submit" className="primary" disabled={saving || !typed.length}>{saving ? 'Saving…' : 'Save names'}</button><button type="button" className="text-button" onClick={onSkip}>Not now</button></div>
    </div>
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
export function MeetingDetail({ meeting, me, onRename, onSpeaker, previous, onPrevious, onToggle, onEdit, onOwner, onDue, onRemove, onOpenPrevious, example, connections, live, cleanDefault, deleteAudio, summarizer, template, autoDraft, onAutoDraft, tab, find = '', armed, onTab, onMarkdown, onNotes, onDraft, onUpdated, onStartCapture, onCloseCapture, onRetry, onExportAudio, onMarkEnded, onDismissRecovered, onSend, onDelete }: {
  meeting: Meeting; me: string; onRename: (title: string) => Promise<void>; onSpeaker: (from: string, to: string) => Promise<void>; previous: Meeting | null; onPrevious: (index: number) => Promise<void>; onToggle: (index: number) => Promise<void>; onEdit: (index: number, text: string) => Promise<void>; onOwner: (index: number, owner: string) => Promise<void>; onDue: (index: number, due: string) => Promise<void>; onRemove: (index: number) => Promise<void>; onOpenPrevious: () => void; example: boolean; connections: Connections; live: CaptureState; cleanDefault: boolean; deleteAudio: boolean; summarizer: Summarizer | null; template?: string;
  /** Hush drafting this meeting after its recording (`drafting`), and how many times it has (`version`). */
  autoDraft?: { drafting: boolean; version: number }; onAutoDraft?: () => void; tab: MeetingTab; find?: string; onTab: (tab: MeetingTab) => void; onSend: () => void; onMarkdown: (markdown: string) => Promise<void>; onNotes: (notes: string) => Promise<void>; onDraft: (notes: string) => void;
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
  // Read on opening, not only on the Transcript tab: Who spoke? needs the voices first thing.
  useEffect(() => {
    if (!recorded) return;
    let cancelled = false;
    transcriptData(meta.id).then(data => { if (!cancelled) setRaw(data); }).catch(() => { if (!cancelled) setRaw(null); });
    return () => { cancelled = true; };
  }, [recorded, meta.id, transcript]);
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
  // Naming a voice in a recorded transcript: asked once it's ready (Who spoke?), or by pressing its label later.
  const canName = Boolean(raw) && !example && meta.status === 'ready';
  const [naming, setNaming] = useState<{ from: string; to: string; error: string } | null>(null);
  const invitedOthers = (meta.attendees ?? []).filter(a => !a.me).map(a => a.name);
  const [skipped, setSkipped] = useState(() => namingSkipped().includes(meta.id));
  const unnamed = canName && !skipped ? unnamedVoices(raw ?? [], invitedOthers) : [];
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
  const here = live.recording?.meetingId === meta.id ? live.recording : null;
  const paused = here?.resumedAt === null;
  // Who's talking before their words arrive, for the live draft's dots.
  const listening = useListening(Boolean(here) && !paused);
  const status = paused ? 'Paused' : statusLabel(meta.status);
  const duration = durationLabel(meta.duration);
  // One row of tabs: the enhanced notes, your own and the transcript.
  const tabs: [MeetingTab, string][] = [['Enhanced', 'Enhanced notes'], ['Notes', 'My notes'], ['Transcript', 'Transcript']];
  const tabIds = (t: string) => ({ tab: `tab-${t}`, panel: `panel-${t}` });
  // Who an item could be for: you, who was invited or typed in, and voices named in the transcript.
  const people = [...new Set([me.trim() || 'You', ...(meta.attendees ?? []).filter(a => !a.me).map(a => a.name || a.email), ...meta.participants, ...turns.map(t => t.speaker).filter(s => !/^(You|Others|Speaker \d+)$/.test(s))].filter(Boolean))];
  const renderAction = (a: ActionItem) => <ActionRow key={a.key} item={a} fresh={a.index === fresh} people={people} onToggle={() => void onToggle(a.index)} onEdit={text => void onEdit(a.index, text)} onOwner={owner => void onOwner(a.index, owner)} onDue={due => void onDue(a.index, due)} onRemove={() => void onRemove(a.index)} />;
  // Rust owns a meeting while it records, waits to be transcribed or is transcribed, so it can't be deleted then.
  const owned = meta.status === 'recording' || meta.status === 'processing' || live.queued.includes(meta.id);
  const docked = armed || live.recording?.meetingId === meta.id || (!live.available && meta.status === 'recording');
  return <article className={`meeting-detail ${docked ? 'docked' : ''}`}>
    <header className="meeting-header">
      <div className="meeting-title-row">
        <div className="meeting-title">
          <h1><Title title={meta.title} editable={meta.status !== 'recording' && meta.status !== 'processing'} onRename={onRename} /></h1>
          <p className="meeting-meta"><span>{meta.project}</span>{example && <span>Example</span>}<span>{dateLabel(meta.date)}, {timeLabel(meta.date)}</span>{duration && <span>{duration}</span>}{status && <span className={`status ${paused ? 'paused' : meta.status}`}><i aria-hidden="true" />{status}</span>}{meta.participants.length > 0 && <Participants names={meta.participants} />}</p>
        </div>
        <div className="meeting-actions">
          {meta.status === 'idle' && !armed && <button className={live.available ? 'primary' : 'secondary'} disabled={Boolean(other)} title={other ? `“${other.title}” is recording. Stop it first.` : undefined} onClick={onStartCapture}>{live.available ? <><i className="record-dot" aria-hidden="true" />Start recording</> : 'Start capture'}</button>}
          {recorded && !armed && <button className="text-button record-more" disabled={Boolean(other)} title={other ? `“${other.title}” is recording. Stop it first.` : 'Record more of this meeting. The new part is added to its transcript.'} onClick={onStartCapture}><i className="record-dot" aria-hidden="true" />Record more</button>}
          {!armed && <button className="icon-button" aria-label="Delete meeting" disabled={owned} title={owned ? (meta.status === 'recording' ? 'Stop recording before deleting this meeting.' : 'Wait until it’s transcribed to delete it.') : 'Delete meeting'} onClick={onDelete}><Icon name="trash" size={16} /></button>}
        </div>
      </div>
      <div className="meeting-tabs" role="tablist" aria-label="Meeting sections" onKeyDown={e => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const at = tabs.findIndex(([t]) => t === tab), next = tabs[(at + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0];
        onTab(next); document.getElementById(tabIds(next).tab)?.focus();
      }}>{tabs.map(([t, label]) => <button key={t} id={tabIds(t).tab} role="tab" aria-selected={t === tab} aria-controls={tabIds(t).panel} tabIndex={t === tab ? 0 : -1} onClick={() => onTab(t)}>{label}</button>)}</div>
    </header>
    {meta.status === 'idle' && other && !armed && <p className="subtle start-hint">“{other.title}” is recording. Stop it before recording this meeting.</p>}
    {meta.interrupted ? <div className={`notice ${meta.status === 'error' ? 'attention' : ''}`} role="status">{meta.status === 'ready' ? <Icon name="info" size={16} /> : <Hush mood={meta.status === 'processing' ? 'transcribing' : 'attention'} size={44} fallback={<Icon name="info" size={16} />} />}<div>
        <strong>Recovered recording</strong>
        <p>QuietNote closed before this recording was stopped. The audio{endedAt && ` up to ${endedAt}`} was saved. {meta.status === 'processing' ? transcribing : meta.status === 'ready' ? 'Its transcript is ready.' : 'Transcription couldn’t finish. Your recording is still saved.'}</p>
        {meta.status === 'error' && details}
      </div><div className="notice-actions">{meta.status === 'error' && audioKept && <button className="text-button" onClick={onRetry}>Retry transcription</button>}{meta.status !== 'processing' && <button className="text-button" onClick={onDismissRecovered}>Dismiss</button>}</div></div>
    : meta.status === 'processing' ? <div className="notice" role="status"><Hush mood="transcribing" size={44} progress={live.transcribing?.meetingId === meta.id ? live.transcribing.percent / 100 : undefined} fallback={<Icon name="recent" size={16} />} /><div><strong>{transcribing}</strong><p>This runs on this {device}. You can keep working or close the window. {deleteAudio ? 'The audio is deleted once the transcript is saved.' : `The audio stays saved on this ${device}.`}</p></div></div>
    : meta.status === 'error' && audioKept ? <div className="notice attention" role="status"><Hush mood="attention" size={44} fallback={<Icon name="info" size={16} />} /><div><strong>Transcription couldn’t finish.</strong><p>Your recording is still saved{meta.duration > 0 ? ` (${durationLabel(meta.duration)})` : ''}, so you can retry.</p>{details}</div><div className="notice-actions"><button className="text-button" onClick={onExportAudio}>Export audio…</button><button className="text-button" onClick={onRetry}>Retry transcription</button></div></div>
    : meta.status === 'error' && <div className="notice attention" role="status"><Hush mood="attention" size={44} fallback={<Icon name="info" size={16} />} /><div><strong>This meeting was interrupted before it finished.</strong><p>{meta.error ?? (live.available ? 'QuietNote closed while it was recording, and no audio was saved.' : 'QuietNote closed while capture was running. No audio was recorded.')} Anything you wrote in Notes is kept.</p></div><div className="notice-actions"><button className="text-button" onClick={() => onTab('Notes')}>Add notes</button><button className="text-button" onClick={onMarkEnded}>Mark as ended</button></div></div>}
    {unnamed.length > 0 && <WhoSpoke key={unnamed.map(v => v.voice).join()} voices={unnamed} invited={invitedOthers} onName={onSpeaker} onCite={cite} onSkip={() => { skipNaming(meta.id); setSkipped(true); }} />}
    <HushYield.Provider value={yielded || meta.status === 'processing' || meta.status === 'error'}><div className="meeting-content" role="tabpanel" id={tabIds(tab).panel} aria-labelledby={tabIds(tab).tab}>
      {tab === 'Enhanced' && (() => {
        // As in Granola, the action items lead the enhanced notes once there are some; until then, adding one is at the end.
        const todo = <section className="note-actions" aria-labelledby="note-actions">
          <div className="note-actions-head"><h3 id="note-actions">Action items</h3>
            {canSend && <button className="text-button send-button" onClick={onSend}><Icon name="arrow" size={15} />{services.length === 1 ? `Send to ${serviceName(services[0])}…` : 'Send to…'}</button>}</div>
          {actions.length > 0 && <div className="action-list">{actions.map(renderAction)}</div>}
          <AddItem label="Add an action item" onAdd={text => onMarkdown(appendAction(markdown, text))} />
        </section>;
        return <>
          {recorded && summarizer && <SuggestPanel meeting={meeting} summarizer={summarizer} template={template} drafting={autoDraft?.drafting} version={autoDraft?.version} onAutoDraft={onAutoDraft} onWorking={setDrafting} onAdded={setFresh} onMarkdown={onMarkdown} onRename={onRename} onSpeaker={onSpeaker} onCite={atMs => cite(clock(atMs / 1000))} />}
          {actions.length > 0 && todo}
          {notes ? <div className="summary-text">{actions.length > 0 && summaryBlocks(notes)[0].kind !== 'heading' && <h3>Summary</h3>}{summaryBlocks(notes).map((b, i) => b.kind === 'heading' ? <h3 key={i}>{b.text}</h3> : b.kind === 'paragraph' ? <p key={i}>{b.text}</p>
            // A point with a transcript time was added from the transcript; the rest came from the notes.
            : <ul key={i}>{b.items.map((item, j) => <li key={j} className={item.at ? 'added' : undefined}>{item.text}{item.at && <> <button className="citation" title="Show this line in the transcript" onClick={() => cite(item.at!)}><span className="timestamp">{item.at}</span></button></>}</li>)}</ul>)}</div>
          : <div className="empty-inline">{calm && <Hush mood="resting" size={72} />}<h2>No enhanced notes yet.</h2><p>{example ? 'Example meetings can’t be enhanced. Record a meeting to enhance its notes.'
            : !live.available ? 'Enhancing needs a transcript, and recording isn’t available on this computer.'
            : recorded ? `Highlight what matters in your notes (${label('CmdOrCtrl+Shift+H')}). ${summarizer ? 'Enhancing them' : 'With suggestions on in Settings → Suggestions, enhancing them'} fills them in from the transcript, each added line in grey with the moment it came from.`
            : summarizer ? 'Once it’s recorded, you can enhance your notes from its transcript.' : 'Turn on suggestions in Settings → Suggestions to enhance your notes from the transcript.'}</p>{recorded && <EnhanceDemo />}<button className="secondary" onClick={() => onTab('Notes')}>Open my notes</button></div>}
          {!actions.length && todo}
        </>;
      })()}
      {tab === 'Notes' && previous && (meta.status === 'idle' || meta.status === 'recording') && <LastTime meeting={previous} me={me} onToggle={onPrevious} onOpen={onOpenPrevious} />}
      {tab === 'Notes' && <div className="quiet-editor"><NotesBoundary><Suspense fallback={<p className="subtle">Opening notes…</p>}><Editor onDraftChange={onDraft} key={meta.id} previewMode={{ content: section(markdown, 'Notes'), title: 'Notes', filePath: meta.meetingPath, modified: 0, hasExternalChanges: false, reloadVersion: 0, save, reload: async () => {} }} /></Suspense></NotesBoundary></div>}
      {tab === 'Transcript' && <section>
        {naming && <form className="name-speaker" onSubmit={e => { e.preventDefault(); if (naming.to.trim()) void nameVoice(naming.from, naming.to); }}>
          <label>Name “{naming.from}” <input aria-label={`Name for ${naming.from}`} list="invited-names" value={naming.to} maxLength={60} autoFocus onChange={e => setNaming({ ...naming, to: e.target.value, error: '' })} /></label>
          <datalist id="invited-names">{invitedOthers.map(n => <option key={n} value={n} />)}</datalist>
          <button type="submit" className="text-button" disabled={!naming.to.trim()}>Save</button><button type="button" className="text-button" onClick={() => setNaming(null)}>Cancel</button>
          {naming.error && <span className="field-error" role="alert">{naming.error}</span>}
          <p className="subtle">Every line by {naming.from} gets this name; the words stay as they were recognized. A name another voice has merges the two.</p>
        </form>}
        {turns.length > 0 && <>
          <div className="transcript-tools">{example && <span className="subtle">Example transcript · illustrative, not a recording</span>}
            {raw && <div className="segmented" role="group" aria-label="Transcript view" title="Clean removes simple filler words and repeated stutters. Verbatim keeps the original transcription."><button aria-pressed={!verbatim} onClick={() => setVerbatim(false)}>Clean</button><button aria-pressed={verbatim} onClick={() => setVerbatim(true)}>Verbatim</button></div>}
            <CopyTranscript title={meta.title} turns={turns} voices={voices} />
            {recorded && meta.audioPath && <button className="text-button" onClick={onExportAudio}><Icon name="folder" size={15} />Export audio…</button>}
            <label className="inline-search"><Icon name="search" size={15} /><input placeholder="Find in transcript" aria-label="Find in transcript" value={transcriptQuery} onChange={e => setTranscriptQuery(e.target.value)} /></label></div>
          {/* Bubbles, as in the live transcript: yours on the right. The voice is named when it changes. */}
          <div className="transcript-turns">{shownTurns.map((t, i) => { const speaks = voices > 1 && t.speaker !== shownTurns[i - 1]?.speaker;
            return <div className={`transcript-turn ${t.speaker === 'You' ? 'you' : 'others'} ${speaks ? 'speaks' : ''}`} data-time={t.time} key={i}>
              <div className="turn-meta">{speaks && (canName ? <button className="speaker-name" title="Name this speaker" onClick={() => setNaming({ from: t.speaker, to: '', error: '' })}>{t.speaker}</button> : <span>{t.speaker}</span>)}<span className="timestamp">{t.time}</span></div>
              <p>{t.text}</p></div>; })}</div>
          {!shownTurns.length && <p className="subtle">Nothing in the transcript matches “{transcriptQuery}”.</p>}
        </>}
        {live.available && !example ? (() => {
          const waiting = turns.length ? null : <div className="empty-inline">{calm && <Hush mood="resting" size={72} />}<h2>{meta.status === 'processing' ? 'Transcribing…' : raw ? 'No speech was recognized.' : 'No transcript yet.'}</h2><p>{meta.status === 'idle' ? `Start recording and QuietNote transcribes the meeting on this ${device} when you stop.` : meta.status === 'processing' || meta.status === 'recording' ? 'The transcript appears here when it’s ready.' : 'Your notes are the record of this meeting.'}</p></div>;
          // While recording, and until the full transcript is ready, the live draft stands in for it (after
          // the earlier transcript, when recording was resumed).
          if (!live.liveTranscript || !(here ? here.liveText !== 'off' : meta.status === 'processing')) return waiting;
          return <LiveTranscript meetingId={meta.id} clean={!verbatim} state={here?.liveText ?? 'on'} listening={here && !paused ? listening : undefined} empty={here ? undefined : waiting}
            caption={here ? `Live draft, transcribed on this ${device}. The full transcript is made when you stop.` : 'Live draft. The full transcript replaces it when it’s ready.'} />;
        })()
        : !turns.length && <div className="empty-inline"><Hush mood="resting" size={72} /><h2>Transcript unavailable.</h2><p>This version doesn’t transcribe audio.</p></div>}
      </section>}
    </div></HushYield.Provider>
    {docked && <Capture meeting={meeting} autoStart={armed} live={live} onUpdated={onUpdated} onClose={onCloseCapture} />}
  </article>;
}
