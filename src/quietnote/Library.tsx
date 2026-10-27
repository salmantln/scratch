import { memo, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { othersWaiting, track, useLevels } from './Capture';
import { Hush, useLook, type Mood } from './Hush';
import { actionItems, dayGroup, durationLabel, shortDate, statusLabel, timeLabel, yoursFirst, type CalendarEvent, type Meeting, type MeetingTab } from './model';
import { isExample } from './seeds';
import * as storage from './storage';

const MeetingRow = memo(function MeetingRow({ meeting, showProject, onOpen }: { meeting: Meeting; showProject: boolean; onOpen: (id: string) => void }) {
  const { id, title, project, date, duration, status } = meeting.metadata;
  const label = statusLabel(status);
  // A status outranks the open count: it's what needs doing first.
  const open = label ? 0 : actionItems(meeting.markdown).filter(a => !a.done).length;
  return <button className={`meeting-row ${showProject ? '' : 'no-project'}`} onClick={() => onOpen(id)}>
    <span className="row-title"><strong>{title}</strong>{isExample(id) && <span className="badge example">Example</span>}</span>
    {showProject && <span className="row-project">{project}</span>}
    <span className="row-date">{dayGroup(date) === 'Today' ? timeLabel(date) : shortDate(date)}</span>
    <span className="row-duration">{durationLabel(duration)}</span>
    <span className="row-status">{label ? <span className={`status ${status}`}><i aria-hidden="true" />{label}</span> : open > 0 && <span className="open-count">{open} open</span>}</span>
  </button>;
});
export function MeetingList({ meetings, showProject, onOpen }: { meetings: Meeting[]; showProject: boolean; onOpen: (id: string) => void }) {
  const groups: [string, Meeting[]][] = [];
  for (const m of meetings) {
    const label = dayGroup(m.metadata.date);
    if (groups[groups.length - 1]?.[0] === label) groups[groups.length - 1][1].push(m); else groups.push([label, [m]]);
  }
  return <div className="meeting-list">{groups.map(([label, items]) => <section key={label} aria-label={label}><h2 className="group-label">{label}</h2>{items.map(m => <MeetingRow key={m.metadata.id} meeting={m} showProject={showProject} onOpen={onOpen} />)}</section>)}</div>;
}
const settingsName = storage.device === 'Mac' ? 'System Settings' : 'Settings';
/** Answers "can I record right now?" from what this device reports, with the fix beside the problem. */
function CaptureCard({ live, onNewMeeting, onRecord, onOpen }: { live: storage.CaptureState; onNewMeeting: () => void; onRecord: () => void; onOpen: (id: string, tab?: MeetingTab) => void }) {
  const { recording, transcribing, queued } = live;
  const denied = live.available && !recording && live.microphone === 'denied';
  const attention = denied || Boolean(recording?.problem) || (live.available && live.model !== 'ready');
  const listening = Boolean(recording && recording.resumedAt !== null);
  const look = useLook(useLevels(listening));
  // Hush shows the one state this card is about: recording first, then a problem, then transcribing.
  const mood: Mood = !live.available ? 'resting' : recording ? listening ? 'listening' : 'paused' : attention ? 'attention' : transcribing ? 'transcribing' : 'ready';
  // With nothing recording or wrong, the card is about the transcription (Start recording still works).
  const job = mood === 'transcribing' ? transcribing : null;
  const title = !live.available ? (storage.desktop ? 'Recording isn’t available on this platform yet.' : 'Recording needs the desktop app.')
    : recording ? `${recording.resumedAt === null ? 'Paused' : 'Recording'} “${recording.title}”`
    : denied ? 'Microphone access is off'
    : job ? `Transcribing on this ${storage.device}`
    : `Ready to record on this ${storage.device}`;
  const detail = !live.available ? 'You can still create meetings and take notes. Capture here is a prototype and records nothing.'
    : recording ? `Started ${timeLabel(recording.startedAt)} by you · No bot joined`
    : denied ? `Allow QuietNote to use the microphone in ${settingsName}, then start recording.`
    : live.microphone === 'undetermined' ? 'The first time you record, QuietNote asks for access to your microphone and system audio. Nothing joins the call.'
    : 'Records your microphone and the call audio. Nothing joins the call.';
  return <section className={`capture-card ${attention ? 'attention' : ''} ${live.available ? '' : 'unavailable'}`} aria-label="Recording">
    <Hush mood={mood} size={56} look={listening ? look : null} progress={job ? job.percent / 100 : undefined} fallback={<i className={recording ? listening ? 'live-dot' : 'paused-dot' : 'ready-dot'} aria-hidden="true" />} />
    <div>
      <strong>{title}</strong>
      {!job && <p>{detail}</p>}
      {recording && recording.resumedAt !== null && <p>{track('Mic', recording.mic)} · {track('Call audio', recording.system, othersWaiting)}</p>}
      {recording?.problem && <p className="capture-card-problem">{recording.problem}</p>}
      {live.available && !recording && live.model !== 'ready' && <p className="capture-card-problem">Transcription is unavailable: the speech model is {live.model}. You can still record.</p>}
      {job ? <><div className="capture-card-progress" role="progressbar" aria-label="Transcription progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.percent}><i style={{ width: `${job.percent}%` }} /></div>
        <p className="capture-card-job">“{job.title}” · {job.percent}%{queued.length > 0 && ` · ${queued.length} more waiting`}<button className="text-button" onClick={() => onOpen(job.meetingId)}>Open meeting</button></p></>
      : transcribing && <p className="capture-card-job">Transcribing “{transcribing.title}” on this {storage.device}… {transcribing.percent}%{queued.length > 0 && ` · ${queued.length} more waiting`}<button className="text-button" onClick={() => onOpen(transcribing.meetingId)}>Open meeting</button></p>}
    </div>
    <div className="notice-actions">
      {recording ? <button className="text-button" onClick={() => onOpen(recording.meetingId, 'Notes')}>Open meeting</button>
      : live.available ? <>{denied && <button className="text-button" onClick={() => void storage.openPrivacySettings('microphone').catch(() => { /* The message says where to go. */ })}>Open {settingsName}</button>}<button className="primary" onClick={onRecord}><i className="record-dot" aria-hidden="true" />Start recording</button></>
      : <button className="secondary" onClick={onNewMeeting}><Icon name="plus" size={15} />New meeting</button>}
    </div>
  </section>;
}
/** Today's meetings still to come or going on, from the calendar: their notes are one press away, and recording
 * still starts only from the meeting. */
function UpNext({ events, meetings, onOpen, onPrepare }: { events: CalendarEvent[]; meetings: Meeting[]; onOpen: (id: string, tab?: MeetingTab) => void; onPrepare: (event: CalendarEvent) => void }) {
  const today = new Date().toDateString();
  const shown = events.filter(e => e.endMs > Date.now() && new Date(e.startMs).toDateString() === today).slice(0, 3);
  if (!shown.length) return null;
  const time = (ms: number) => timeLabel(new Date(ms).toISOString());
  return <section className="home-section" aria-labelledby="home-next">
    <h2 id="home-next">Up next</h2>
    <ul className="up-next">{shown.map(e => {
      const notes = meetings.find(m => m.metadata.calendarEvent === e.id);
      const others = e.attendees.filter(a => !a.me);
      return <li key={e.id}>
        <span className="up-next-time">{time(e.startMs)}–{time(e.endMs)}</span>
        <span className="up-next-title">{e.title}{others.length > 0 && <span className="subtle"> · {others.length === 1 ? others[0].name : `${others.length} others`}</span>}</span>
        {notes ? <button className="text-button" onClick={() => onOpen(notes.metadata.id, 'Notes')}>Open notes</button> : <button className="text-button" onClick={() => onPrepare(e)}>Prepare notes</button>}
      </li>;
    })}</ul>
  </section>;
}
type HomeProps = {
  meetings: Meeting[]; me: string; live: storage.CaptureState; events: CalendarEvent[]; onPrepare: (event: CalendarEvent) => void; onOpen: (id: string, tab?: MeetingTab) => void; onNewMeeting: () => void; onRecord: () => void;
  onSearch: (text: string) => void; onToggle: (id: string, index: number) => Promise<void>; onAll: () => void; onAllActions: () => void;
};
const recentCount = 10;
const itemCount = 6;
/** Home: whether you can record, what you owe people, and what happened lately. Sections with nothing to show are left out. */
export function Home({ meetings, me, live, events, onPrepare, onOpen, onNewMeeting, onRecord, onSearch, onToggle, onAll, onAllActions }: HomeProps) {
  // Items ticked here stay listed (struck through) until you leave, so a mistaken tick is easy to undo.
  const [ticked, setTicked] = useState<string[]>([]);
  const items = useMemo(() => yoursFirst(meetings.flatMap(({ metadata, markdown }) => actionItems(markdown)
    .map(item => ({ item, meeting: metadata, key: `${metadata.id}:${item.key}` }))
    .filter(({ item, key }) => !item.done || ticked.includes(key))), i => i.item.owner, me), [meetings, ticked, me]);
  const open = items.filter(i => !i.item.done).length;
  const shown = items.slice(0, itemCount);
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return <div className="page home-page">
    <header className="page-header"><h1>{today}</h1></header>
    <UpNext events={events} meetings={meetings} onOpen={onOpen} onPrepare={onPrepare} />
    <CaptureCard live={live} onNewMeeting={onNewMeeting} onRecord={onRecord} onOpen={onOpen} />
    {meetings.length > 0 && <label className="search-field home-search"><Icon name="search" size={18} /><input type="search" aria-label="Search meetings" placeholder="Search meetings, notes and transcripts…" value="" onChange={e => onSearch(e.target.value)} /><kbd aria-hidden="true">⌘K</kbd></label>}
    {items.length > 0 && <section className="home-section" aria-labelledby="home-actions">
      <h2 id="home-actions">Open action items<span className="home-count">{open}</span></h2>
      <div className="action-list">{shown.map(({ item, meeting, key }) => <label className={`action-row home-action ${item.done ? 'complete' : ''}`} key={key}>
        <input type="checkbox" checked={item.done} onChange={() => { setTicked(t => t.includes(key) ? t : [...t, key]); void onToggle(meeting.id, item.index); }} />
        <span className="action-text">{item.text}</span>
        {item.link && <button className="action-link" title={item.link.url} onClick={e => { e.preventDefault(); void storage.openLink(item.link!.url); }}>{item.link.label}</button>}
        <span className="action-from">{item.owner && <span className="action-owner">{item.owner}</span>}<button className="text-button action-source" title={`Open ${meeting.title}`} onClick={e => { e.preventDefault(); onOpen(meeting.id, 'Enhanced'); }}>{meeting.title}</button></span>
      </label>)}</div>
      {items.length > itemCount && <button className="text-button see-all" onClick={onAllActions}>All action items<Icon name="arrow" size={14} /></button>}
    </section>}
    {meetings.length > 0 && <section className="home-section" aria-labelledby="home-recent">
      <h2 id="home-recent">Recent</h2>
      <MeetingList meetings={meetings.slice(0, recentCount)} showProject onOpen={onOpen} />
      {meetings.length > recentCount && <button className="text-button see-all" onClick={onAll}>All {meetings.length} meetings<Icon name="arrow" size={14} /></button>}
    </section>}
  </div>;
}
/** Every meeting's action items in one place, under the meeting each came from, newest first: the open ones, or
 * those done. A tick is written to its meeting, and the item stays where it is until you leave, as on Home. */
export function ActionItems({ meetings, me, onOpen, onToggle }: { meetings: Meeting[]; me: string; onOpen: (id: string, tab?: MeetingTab) => void; onToggle: (id: string, index: number) => Promise<void> }) {
  const [done, setDone] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const all = useMemo(() => meetings.map(({ metadata, markdown }) => ({ meeting: metadata, items: yoursFirst(actionItems(markdown), i => i.owner, me) })), [meetings, me]);
  const open = all.reduce((n, g) => n + g.items.filter(i => !i.done).length, 0);
  const groups = all.map(g => ({ ...g, items: g.items.filter(i => i.done === done || ticked.includes(`${g.meeting.id}:${i.key}`)) })).filter(g => g.items.length);
  const show = (next: boolean) => { setDone(next); setTicked([]); };
  return <div className="page actions-page">
    <header className="page-header"><div><h1>Action items</h1><p className="subtle">{open} open</p></div>
      <div className="segmented" role="group" aria-label="Show action items"><button aria-pressed={!done} onClick={() => show(false)}>Open</button><button aria-pressed={done} onClick={() => show(true)}>Done</button></div></header>
    {groups.length ? groups.map(({ meeting, items }) => <section className="action-group" key={meeting.id} aria-label={meeting.title}>
      <h2 className="group-label action-group-head"><button className="text-button" title={`Open ${meeting.title}`} onClick={() => onOpen(meeting.id, 'Enhanced')}>{meeting.title}</button><span>{shortDate(meeting.date)} · {meeting.project}</span></h2>
      <div className="action-list">{items.map(item => { const key = `${meeting.id}:${item.key}`; return <label className={`action-row ${item.done ? 'complete' : ''}`} key={key}>
        <input type="checkbox" checked={item.done} onChange={() => { setTicked(t => t.includes(key) ? t : [...t, key]); void onToggle(meeting.id, item.index); }} />
        <span><span className="action-text">{item.text}</span>{item.owner && <span className="action-owner">{item.owner}</span>}</span>
        {item.link && <button className="action-link" title={item.link.url} onClick={e => { e.preventDefault(); void storage.openLink(item.link!.url); }}>{item.link.label}</button>}
      </label>; })}</div>
    </section>)
    : <div className="empty-state"><Hush mood="resting" size={88} fallback={<Icon name="task" size={28} />} /><h2>{done ? 'Nothing done yet.' : 'Nothing open.'}</h2><p>{done ? 'Action items you tick off are listed here.' : 'Action items from your meetings are listed here. Add them in a meeting’s enhanced notes.'}</p></div>}
  </div>;
}
