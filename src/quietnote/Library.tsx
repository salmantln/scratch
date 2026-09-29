import { memo, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { track } from './Capture';
import { actionItems, dayGroup, durationLabel, shortDate, statusLabel, timeLabel, type Meeting, type MeetingTab } from './model';
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
function CaptureCard({ live, onNewMeeting, onOpen }: { live: storage.CaptureState; onNewMeeting: () => void; onOpen: (id: string, tab?: MeetingTab) => void }) {
  const { recording, transcribing, queued } = live;
  const denied = live.available && !recording && live.microphone === 'denied';
  const attention = denied || Boolean(recording?.problem) || (live.available && live.model !== 'ready');
  const title = !live.available ? (storage.desktop ? 'Recording isn’t available on this platform yet.' : 'Recording needs the desktop app.')
    : recording ? `Recording “${recording.title}”`
    : denied ? 'Microphone access is off'
    : `Ready to record on this ${storage.device}`;
  const detail = !live.available ? 'You can still create meetings and take notes. Capture here is a prototype and records nothing.'
    : recording ? `Started ${timeLabel(recording.startedAt)} by you · No bot joined`
    : denied ? `Allow QuietNote to use the microphone in ${settingsName}, then start recording.`
    : live.microphone === 'undetermined' ? 'The first time you record, QuietNote asks for access to your microphone and system audio. Nothing joins the call.'
    : 'Records your microphone and the call audio. Nothing joins the call.';
  return <section className={`capture-card ${attention ? 'attention' : ''} ${live.available ? '' : 'unavailable'}`} aria-label="Recording">
    <i className={recording ? 'live-dot' : 'ready-dot'} aria-hidden="true" />
    <div>
      <strong>{title}</strong>
      <p>{detail}</p>
      {recording && <p>{track('Mic', recording.mic)} · {track('Call audio', recording.system)}</p>}
      {recording?.problem && <p className="capture-card-problem">{recording.problem}</p>}
      {live.available && !recording && live.model !== 'ready' && <p className="capture-card-problem">Transcription is unavailable: the speech model is {live.model}. You can still record.</p>}
      {transcribing && <p className="capture-card-job">Transcribing “{transcribing.title}” on this {storage.device}… {transcribing.percent}%{queued.length > 0 && ` · ${queued.length} more waiting`}<button className="text-button" onClick={() => onOpen(transcribing.meetingId)}>Open meeting</button></p>}
    </div>
    <div className="notice-actions">
      {recording ? <button className="text-button" onClick={() => onOpen(recording.meetingId, 'Notes')}>Open meeting</button>
      : live.available ? <>{denied && <button className="text-button" onClick={() => void storage.openPrivacySettings('microphone').catch(() => { /* The message says where to go. */ })}>Open {settingsName}</button>}<button className="primary" onClick={onNewMeeting}><i className="record-dot" aria-hidden="true" />Start recording</button></>
      : <button className="secondary" onClick={onNewMeeting}><Icon name="plus" size={15} />New meeting</button>}
    </div>
  </section>;
}
type HomeProps = {
  meetings: Meeting[]; live: storage.CaptureState; onOpen: (id: string, tab?: MeetingTab) => void; onNewMeeting: () => void;
  onSearch: (text: string) => void; onToggle: (id: string, index: number) => Promise<void>; onAll: () => void;
};
const recentCount = 10;
const itemCount = 6;
/** Home: whether you can record, what you owe people, and what happened lately. Sections with nothing to show are left out. */
export function Home({ meetings, live, onOpen, onNewMeeting, onSearch, onToggle, onAll }: HomeProps) {
  // Items ticked here stay listed (struck through) until you leave, so a mistaken tick is easy to undo.
  const [ticked, setTicked] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const items = useMemo(() => meetings.flatMap(({ metadata, markdown }) => actionItems(markdown)
    .map(item => ({ item, meeting: metadata, key: `${metadata.id}:${item.index}` }))
    .filter(({ item, key }) => !item.done || ticked.includes(key))), [meetings, ticked]);
  const open = items.filter(i => !i.item.done).length;
  const shown = expanded ? items : items.slice(0, itemCount);
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return <div className="page home-page">
    <header className="page-header"><h1>{today}</h1></header>
    <CaptureCard live={live} onNewMeeting={onNewMeeting} onOpen={onOpen} />
    {meetings.length > 0 && <label className="search-field home-search"><Icon name="search" size={18} /><input type="search" aria-label="Search meetings" placeholder="Search meetings, decisions and transcripts…" value="" onChange={e => onSearch(e.target.value)} /><kbd aria-hidden="true">⌘K</kbd></label>}
    {items.length > 0 && <section className="home-section" aria-labelledby="home-actions">
      <h2 id="home-actions">Open action items<span className="home-count">{open}</span></h2>
      <div className="action-list">{shown.map(({ item, meeting, key }) => <label className={`action-row home-action ${item.done ? 'complete' : ''}`} key={key}>
        <input type="checkbox" checked={item.done} onChange={() => { setTicked(t => t.includes(key) ? t : [...t, key]); void onToggle(meeting.id, item.index); }} />
        <span className="action-text">{item.text}</span>
        {item.link && <button className="action-link" title={item.link.url} onClick={e => { e.preventDefault(); void storage.openLink(item.link!.url); }}>{item.link.label}</button>}
        <span className="action-from">{item.owner && <span className="action-owner">{item.owner}</span>}<button className="text-button action-source" title={`Open ${meeting.title}`} onClick={e => { e.preventDefault(); onOpen(meeting.id, 'Action items'); }}>{meeting.title}</button></span>
      </label>)}</div>
      {items.length > itemCount && <button className="text-button see-all" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? 'Show fewer' : `Show all ${items.length}`}</button>}
    </section>}
    {meetings.length > 0 && <section className="home-section" aria-labelledby="home-recent">
      <h2 id="home-recent">Recent</h2>
      <MeetingList meetings={meetings.slice(0, recentCount)} showProject onOpen={onOpen} />
      {meetings.length > recentCount && <button className="text-button see-all" onClick={onAll}>All {meetings.length} meetings<Icon name="arrow" size={14} /></button>}
    </section>}
  </div>;
}
