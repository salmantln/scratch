import { useMemo, useState } from 'react';
import { Icon } from './Icon';
import { MeetingList } from './Library';
import { actionItems, owns, people, shortDate, type Meeting, type MeetingTab, type Person } from './model';
/** Who the user meets, from calendar invites: everyone, grouped by company (their email's domain), and a page for
 * each person or company with the meetings they were in and the action items they own. `selected` is a person's
 * key or `@domain`. Built from the meetings on this device only. */
export function People({ meetings, selected, calendar, onSelect, onOpen, onToggle, onSettings }: {
  meetings: Meeting[]; selected: string; calendar: boolean; onSelect: (key: string) => void; onOpen: (id: string, tab?: MeetingTab) => void;
  onToggle: (id: string, index: number) => Promise<void>; onSettings: () => void;
}) {
  const everyone = useMemo(() => people(meetings), [meetings]);
  const [query, setQuery] = useState('');
  if (selected) return <Detail key={selected} everyone={everyone} meetings={meetings} selected={selected} onSelect={onSelect} onOpen={onOpen} onToggle={onToggle} />;
  const q = query.trim().toLowerCase();
  const shown = everyone.filter(p => !q || `${p.name} ${p.email} ${p.company}`.toLowerCase().includes(q));
  const companies = [...new Set(shown.map(p => p.company))].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b));
  return <div className="page people-page">
    <header className="page-header"><h1>People</h1></header>
    {everyone.length === 0 ? <div className="empty-state"><Icon name="people" size={28} /><h2>No people yet.</h2>
      <p>{calendar ? 'People come from your meetings’ calendar invites. Meetings made from an event list who was invited.' : 'People come from calendar invites. Turn on your calendar in Settings and your meetings list who was invited.'}</p>
      {!calendar && <button className="secondary" onClick={onSettings}>Open Settings</button>}</div>
    : <>
      <label className="search-field"><Icon name="search" size={18} /><input type="search" aria-label="Search people" placeholder="Search people and companies…" value={query} onChange={e => setQuery(e.target.value)} /></label>
      {companies.map(company => <section className="home-section" key={company || 'other'} aria-label={company || 'Other people'}>
        <h2>{company ? <button className="text-button company-link" onClick={() => onSelect(`@${company}`)}>{company}<Icon name="arrow" size={14} /></button> : 'Other people'}</h2>
        <ul className="people-list">{shown.filter(p => p.company === company).map(p => <li key={p.key}>
          <button onClick={() => onSelect(p.key)}><span className="person-name">{p.name}</span>{p.email && <span className="subtle">{p.email}</span>}
            <span className="subtle person-meta">{p.meetingIds.length} {p.meetingIds.length === 1 ? 'meeting' : 'meetings'} · {shortDate(p.lastMet)}</span></button>
        </li>)}</ul>
      </section>)}
      {!shown.length && <p className="subtle">Nobody matches “{query}”.</p>}
    </>}
  </div>;
}
/** One person, or everyone at one company: their meetings, newest first, and the open action items they own. */
function Detail({ everyone, meetings, selected, onSelect, onOpen, onToggle }: {
  everyone: Person[]; meetings: Meeting[]; selected: string; onSelect: (key: string) => void; onOpen: (id: string, tab?: MeetingTab) => void; onToggle: (id: string, index: number) => Promise<void>;
}) {
  const company = selected.startsWith('@') ? selected.slice(1) : '';
  const group = company ? everyone.filter(p => p.company === company) : everyone.filter(p => p.key === selected);
  // Ticked here, an item stays listed (struck through) until you leave, as on Home.
  const [ticked, setTicked] = useState<string[]>([]);
  const ids = new Set(group.flatMap(p => p.meetingIds));
  const theirs = meetings.filter(m => ids.has(m.metadata.id)).sort((a, b) => b.metadata.date.localeCompare(a.metadata.date));
  const items = theirs.flatMap(({ metadata, markdown }) => actionItems(markdown).map(item => ({ item, meeting: metadata, key: `${metadata.id}:${item.index}` })))
    .filter(({ item, key }) => group.some(p => owns(p, item.owner)) && (!item.done || ticked.includes(key)));
  const person = group[0];
  if (!person) return <div className="page"><button className="text-button" onClick={() => onSelect('')}><Icon name="back" size={15} />People</button><p className="subtle">This person isn’t in any meeting any more.</p></div>;
  return <div className="page people-page">
    <button className="text-button back-link" onClick={() => onSelect('')}><Icon name="back" size={15} />People</button>
    <header className="page-header"><h1>{company || person.name}</h1>
      <p className="subtle">{company ? `${group.length} ${group.length === 1 ? 'person' : 'people'} · ${theirs.length} ${theirs.length === 1 ? 'meeting' : 'meetings'}`
        : <>{person.email}{person.company && <> · <button className="text-button company-link" onClick={() => onSelect(`@${person.company}`)}>{person.company}</button></>}</>}</p></header>
    {company && <ul className="people-list compact">{group.map(p => <li key={p.key}><button onClick={() => onSelect(p.key)}><span className="person-name">{p.name}</span><span className="subtle">{p.email}</span></button></li>)}</ul>}
    {items.length > 0 && <section className="home-section" aria-labelledby="person-actions">
      <h2 id="person-actions">{company ? 'Their open action items' : `${person.name.split(/\s+/)[0]}’s open action items`}</h2>
      <div className="action-list">{items.map(({ item, meeting, key }) => <label className={`action-row home-action ${item.done ? 'complete' : ''}`} key={key}>
        <input type="checkbox" checked={item.done} onChange={() => { setTicked(t => [...t, key]); void onToggle(meeting.id, item.index); }} />
        <span className="action-text">{item.text}</span>
        <span className="action-from">{item.owner && <span className="action-owner">{item.owner}</span>}<button className="text-button action-source" title={`Open ${meeting.title}`} onClick={e => { e.preventDefault(); onOpen(meeting.id, 'Action items'); }}>{meeting.title}</button></span>
      </label>)}</div>
    </section>}
    <section className="home-section" aria-labelledby="person-meetings">
      <h2 id="person-meetings">Meetings</h2>
      <MeetingList meetings={theirs} showProject onOpen={id => onOpen(id)} />
    </section>
  </div>;
}
