export type MeetingStatus = 'idle' | 'recording' | 'processing' | 'ready' | 'error';
export interface MeetingMetadata {
  id: string;
  title: string;
  date: string;
  duration: number;
  project: string;
  participants: string[];
  status: MeetingStatus;
  captureStartedAt: string | null;
  captureEndedAt: string | null;
  audioPath: string | null;
  transcriptPath: string;
  meetingPath: string;
  tags: string[];
  /** Recovered after QuietNote closed mid-recording, until the user dismisses the notice. */
  interrupted?: boolean;
  /** Why the last transcription failed; the audio is kept for a retry. */
  error?: string | null;
  /** Set while recording resumed on a finished meeting: where the new part begins (Rust owns it). */
  resume?: { atMs: number; sample: number } | null;
  /** The calendar event occurrence the meeting was made from, and its series (a weekly meeting's every week). */
  calendarEvent?: string;
  calendarSeries?: string;
  /** Who was invited, from the calendar. `participants` holds the others' names. */
  attendees?: Attendee[];
}
/** Someone invited, as the calendar says; `me` is the user. */
export interface Attendee { name: string; email: string; me?: boolean }
/** One occurrence of a calendar event, read from the Mac's calendars (Rust `calendar`). */
export interface CalendarEvent { id: string; series: string | null; title: string; startMs: number; endMs: number; attendees: Attendee[]; link: string | null }
export interface Meeting { metadata: MeetingMetadata; markdown: string; transcript: string }
export type MeetingTab = 'Summary' | 'Decisions' | 'Action items' | 'Notes' | 'Transcript';
export const meetingTabs: MeetingTab[] = ['Summary', 'Decisions', 'Action items', 'Notes', 'Transcript'];
export interface ActionItem { index: number; done: boolean; text: string; owner: string; link?: { label: string; url: string } }
export interface TranscriptTurn { time: string; speaker: string; text: string }
export function section(markdown: string, name: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => line.trim().toLowerCase() === `## ${name.toLowerCase()}`);
  if (start < 0) return '';
  const end = name.toLowerCase() === 'notes' ? -1 : lines.findIndex((line, i) => i > start && /^## /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}
export function replaceSection(markdown: string, name: string, content: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => line.trim().toLowerCase() === `## ${name.toLowerCase()}`);
  if (start < 0) return `${markdown.trimEnd()}\n\n## ${name}\n${content}\n`;
  const end = name.toLowerCase() === 'notes' ? -1 : lines.findIndex((line, i) => i > start && /^## /.test(line));
  return [...lines.slice(0, start + 1), content.trim(), '', ...(end < 0 ? [] : lines.slice(end))].join('\n');
}
export function toggleAction(markdown: string, index: number): string {
  let current = -1;
  return replaceSection(markdown, 'Action items', section(markdown, 'Action items').replace(/^- \[([ xX])\] (.*)$/gm, (line, done, text) => {
    current++;
    return current === index ? `- [${done === ' ' ? 'x' : ' '}] ${text}` : line;
  }));
}
// A sent action item keeps its issue link at the end of its own line: `- [ ] Maya — task [ENG-12](https://…)`.
const trailingLink = / \[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/;
export function linkAction(markdown: string, index: number, label: string, url: string): string {
  let current = -1;
  return replaceSection(markdown, 'Action items', section(markdown, 'Action items').replace(/^- \[([ xX])\] (.*)$/gm, line => ++current === index && !trailingLink.test(line) ? `${line} [${label.replace(/[[\]]/g, '')}](${url})` : line));
}
export function appendItem(markdown: string, name: 'Decisions' | 'Action items', text: string): string {
  const line = name === 'Decisions' ? `- ${text.trim()}` : `- [ ] ${text.trim()}`;
  return replaceSection(markdown, name, [section(markdown, name), line].filter(Boolean).join('\n'));
}
export function decisions(markdown: string): string[] {
  return section(markdown, 'Decisions').split('\n').filter(l => /^[-*] /.test(l)).map(l => l.slice(2).trim());
}
export function actionItems(markdown: string): ActionItem[] {
  return section(markdown, 'Action items').split('\n').filter(l => /^- \[[ xX]\] /.test(l)).map((line, index) => {
    const match = line.match(trailingLink);
    const text = line.slice(6, match?.index).trim();
    const [owner, ...rest] = text.split(' — ');
    return { index, done: /^- \[[xX]\]/.test(line), text: rest.length ? rest.join(' — ') : text, owner: rest.length ? owner : '', ...(match && { link: { label: match[1], url: match[2] } }) };
  });
}
/** The project a meeting from `event` belongs in: that of the series' last meeting, else the one where most of
 * the same people's earlier meetings are, else `fallback`. */
export function projectFor(event: CalendarEvent, all: Meeting[], fallback: string): string {
  const latest = [...all].sort((a, b) => b.metadata.date.localeCompare(a.metadata.date));
  const series = event.series && latest.find(m => m.metadata.calendarSeries === event.series);
  if (series) return series.metadata.project;
  const emails = new Set(event.attendees.filter(a => !a.me && a.email).map(a => a.email));
  const counts = new Map<string, number>();
  for (const m of latest) if ((m.metadata.attendees ?? []).some(a => !a.me && emails.has(a.email))) counts.set(m.metadata.project, (counts.get(m.metadata.project) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
}
/** Someone the user meets, from meetings' invites (or names typed as participants): `key` is their email, or
 * their name without one. `company` is their email's domain, unless it's a personal address or the user's own. */
export interface Person { key: string; name: string; email: string; company: string; meetingIds: string[]; lastMet: string }
const personalDomains = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'mac.com', 'yahoo.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.com']);
export function people(all: Meeting[]): Person[] {
  const own = new Set(all.flatMap(m => (m.metadata.attendees ?? []).filter(a => a.me && a.email).map(a => a.email.split('@')[1])));
  const found = new Map<string, Person>();
  for (const { metadata } of [...all].sort((a, b) => b.metadata.date.localeCompare(a.metadata.date))) {
    const invited = metadata.attendees?.length ? metadata.attendees.filter(a => !a.me) : metadata.participants.map(name => ({ name, email: '' }));
    for (const { name, email } of invited) {
      const key = (email || name).trim().toLowerCase();
      if (!key) continue;
      const domain = email.split('@')[1] ?? '';
      const person = found.get(key) ?? { key, name: name.trim() || email, email, company: domain && !personalDomains.has(domain) && !own.has(domain) ? domain : '', meetingIds: [], lastMet: metadata.date };
      if (!person.meetingIds.includes(metadata.id)) person.meetingIds.push(metadata.id);
      found.set(key, person);
    }
  }
  return [...found.values()].sort((a, b) => b.lastMet.localeCompare(a.lastMet));
}
/** Whether an action item's owner ("Maria", "Maria Lopez") is this person. */
export function owns(person: Person, owner: string): boolean {
  const o = owner.trim().toLowerCase();
  const name = person.name.toLowerCase();
  return Boolean(o) && (o === name || o === name.split(/\s+/)[0] || (Boolean(person.email) && o === person.email));
}
/** The meeting file with a new title on its `# ` line. */
export function retitle(markdown: string, title: string): string {
  const lines = markdown.split('\n');
  const at = lines.findIndex(l => l.startsWith('# '));
  if (at < 0) return `# ${title}\n\n${markdown}`;
  lines[at] = `# ${title}`;
  return lines.join('\n');
}
/** Whether a title is one QuietNote gave by itself, worth replacing with a real one. */
export const madeUp = (title: string) => generic.test(title.trim());
/** Titles QuietNote gives a meeting by itself ("Zoom call"), which don't make meetings a series. */
const generic = /^(untitled meeting|new meeting|.+ call)$/i;
/** The meeting before this one, to carry its open action items and decisions into this one: the latest earlier
 * meeting of the same series (same title) in the project, or else the latest earlier one in the project. Only
 * worth showing when it left something open, so `null` otherwise. Examples only lead to examples. */
export function previousMeeting(meeting: Meeting, all: Meeting[], example: (id: string) => boolean): Meeting | null {
  const { id, project, date, title } = meeting.metadata;
  const earlier = all.filter(m => m.metadata.id !== id && m.metadata.project === project && m.metadata.date < date && example(m.metadata.id) === example(id))
    .sort((a, b) => b.metadata.date.localeCompare(a.metadata.date));
  const calendar = meeting.metadata.calendarSeries && earlier.find(m => m.metadata.calendarSeries === meeting.metadata.calendarSeries);
  const series = calendar || (generic.test(title.trim()) ? undefined : earlier.find(m => m.metadata.title.trim().toLowerCase() === title.trim().toLowerCase()));
  const previous = series ?? earlier[0];
  return previous && (actionItems(previous.markdown).some(a => !a.done) || decisions(previous.markdown).length > 0) ? previous : null;
}
/** Enhanced notes as Markdown for the Summary section: a `###` heading per section, a line per point, and the
 * transcript time after each point that came from it (`[12:04]`). Points from the user's own notes have none. */
export function notesMarkdown(sections: { heading: string; lines: { text: string; atMs: number | null }[] }[]): string {
  return sections.map(s => `### ${s.heading}\n${s.lines.map(l => `- ${l.text}${l.atMs === null ? '' : ` [${clock(l.atMs / 1000)}]`}`).join('\n')}`).join('\n\n');
}
export type SummaryBlock = { kind: 'heading'; text: string } | { kind: 'paragraph'; text: string } | { kind: 'list'; items: { text: string; at: string | null }[] };
/** The Summary section as headings, lists and paragraphs, with a list item's trailing `[mm:ss]` as its transcript time. */
export function summaryBlocks(summary: string): SummaryBlock[] {
  const blocks: SummaryBlock[] = [];
  for (const chunk of summary.split(/\n{2,}/)) {
    let paragraph: string[] = [];
    const flush = () => { if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') }); paragraph = []; };
    for (const line of chunk.split('\n')) {
      const heading = line.match(/^#{3,6} (.+)$/);
      const item = line.match(/^[-*] (.+?)(?: \[(\d{1,2}:\d{2}(?::\d{2})?)\])?$/);
      if (heading) { flush(); blocks.push({ kind: 'heading', text: heading[1].trim() }); }
      else if (item) {
        flush();
        const last = blocks[blocks.length - 1];
        const entry = { text: item[1].trim(), at: item[2] ?? null };
        if (last?.kind === 'list') last.items.push(entry); else blocks.push({ kind: 'list', items: [entry] });
      } else if (line.trim()) paragraph.push(line.trim());
    }
    flush();
  }
  return blocks;
}
/** The template that fits a meeting's title best, from those available ("Weekly 1:1" → 1:1). */
/** The template a meeting's title suggests, else the one chosen when setting up (`preferred`), else General. */
export function templateFor(title: string, names: string[], preferred = ''): string {
  const fits: [RegExp, string][] = [[/\b1[:-]1\b|one[- ]on[- ]one/i, '1:1'], [/stand-?up/i, 'Standup'], [/sales|demo|discovery|prospect/i, 'Sales call'], [/interview/i, 'User interview'], [/kick-?off/i, 'Project kickoff']];
  const fit = fits.find(([pattern, name]) => pattern.test(title) && names.includes(name))?.[1];
  return fit ?? (names.includes(preferred) ? preferred : names.find(n => n === 'General')) ?? names[0] ?? '';
}
export function transcriptTurns(transcript: string): TranscriptTurn[] {
  return transcript.split(/^### /m).slice(1).map(chunk => {
    const [heading, ...body] = chunk.trim().split('\n');
    const [time, ...speaker] = heading.split(' ');
    return { time, speaker: speaker.join(' '), text: body.join('\n').trim() };
  });
}
export function matchesMeeting(meeting: Meeting, query: string): boolean {
  const haystack = [meeting.metadata.title, meeting.metadata.project, ...meeting.metadata.tags, ...meeting.metadata.participants, ...(meeting.metadata.attendees ?? []).map(a => a.email), meeting.markdown, meeting.transcript].join(' ').toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every(term => haystack.includes(term));
}
export function searchTerms(query: string): string[] { return query.trim().toLowerCase().split(/\s+/).filter(Boolean); }
// Finds where a query matched so results can show context and open the matching tab.
export function searchMeeting(meeting: Meeting, query: string): { tab: MeetingTab; snippet: string } | null {
  const terms = searchTerms(query);
  if (!terms.length || !matchesMeeting(meeting, query)) return null;
  const { markdown, metadata } = meeting;
  const fields: [MeetingTab, string][] = [
    ['Summary', section(markdown, 'Summary')],
    ['Decisions', decisions(markdown).join(' · ')],
    ['Action items', actionItems(markdown).map(a => a.owner ? `${a.text} (${a.owner})` : a.text).join(' · ')],
    ['Notes', section(markdown, 'Notes').replace(/^#+ |^[-*] |\*\*/gm, '')],
    ['Transcript', transcriptTurns(meeting.transcript).map(t => `${t.speaker}: ${t.text}`).join(' · ')],
  ];
  const phrase = terms.join(' ');
  const hit = fields.find(([, text]) => text.toLowerCase().includes(phrase)) ?? fields.find(([, text]) => terms.some(term => text.toLowerCase().includes(term)));
  if (!hit) return { tab: 'Summary', snippet: excerpt(section(markdown, 'Summary') || metadata.participants.join(', '), '') };
  const lower = hit[1].toLowerCase();
  return { tab: hit[0], snippet: excerpt(hit[1], lower.includes(phrase) ? phrase : terms.find(term => lower.includes(term)) ?? '') };
}
function excerpt(text: string, term: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = term ? flat.toLowerCase().indexOf(term) : 0;
  const start = Math.max(0, at - 60);
  const end = Math.min(flat.length, Math.max(at, 0) + term.length + 100);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}
export function statusLabel(status: MeetingStatus): string {
  return { idle: '', ready: '', recording: 'Recording', processing: 'Transcribing', error: 'Needs attention' }[status];
}
export function validProjectName(name: string): string {
  const value = name.trim();
  if (!value) return 'Enter a project name.';
  if (value.length > 60) return 'Keep the name under 60 characters.';
  if (!/^[\p{L}\p{N} _-]+$/u.test(value) || value === '.' || value === '..') return 'Use letters, numbers, spaces, hyphens or underscores.';
  return '';
}
export function dateLabel(date: string): string {
  return new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function shortDate(date: string, now = new Date()): string {
  const value = new Date(date);
  return value.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(value.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}
export function timeLabel(date: string): string { return new Date(date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
/** Elapsed recording time, the same in the window and the tray: `mm:ss`, then `h:mm:ss`. */
/** How a recording about to stop by itself counts down: the time left, then waiting for quiet (Rust stops it only once nobody's talking). */
export function stopsIn(stopsAt: string, now: number): string {
  const left = Math.ceil((Date.parse(stopsAt) - now) / 1000);
  return left > 0 ? `Recording stops in ${clock(left)}.` : 'Recording stops once it’s quiet.';
}
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds)), pad = (n: number) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
/** Recorded seconds of a live recording: what was recorded before the last resume, plus the time since. Pauses don't count. */
export function recorded(r: { recordedMs: number; resumedAt: string | null }, now: number): number { return (r.recordedMs + (r.resumedAt ? now - Date.parse(r.resumedAt) : 0)) / 1000; }
export function durationLabel(seconds: number): string { return seconds <= 0 ? '' : seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`; }
export function dayGroup(date: string, now = new Date()): string {
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const value = new Date(date);
  const days = Math.round((day(now) - day(value)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  return value.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}
/** A new meeting; from a calendar event, it's dated at the event and knows who was invited and which series it's in. */
export function makeMeeting(title: string, project: string, event?: CalendarEvent | null): Meeting {
  const now = event ? new Date(event.startMs).toISOString() : new Date().toISOString();
  const id = `${now.slice(0, 10)}-${crypto.randomUUID()}`;
  const invited = event ? { participants: event.attendees.filter(a => !a.me).map(a => a.name), attendees: event.attendees, calendarEvent: event.id, ...(event.series && { calendarSeries: event.series }) } : { participants: [] };
  return {
    metadata: { id, title, project, date: now, duration: 0, status: 'idle', captureStartedAt: null, captureEndedAt: null, audioPath: null, transcriptPath: `${project}/${id}/transcript.md`, meetingPath: `${project}/${id}/meeting.md`, tags: [], ...invited },
    markdown: `# ${title}\n\nDate: ${dateLabel(now)}\nProject: ${project}\n\n## Summary\n\n## Decisions\n\n## Action items\n\n## Notes\n`,
    transcript: '# Transcript\n',
  };
}
/** The issue that an action item becomes. Only the item, its owner and the meeting's title, date and project leave the device. */
export function issueFor(item: { text: string; owner: string }, meeting: { title: string; date: string; project: string }) {
  return { title: item.text, body: `From “${meeting.title}” (${meeting.date.slice(0, 10)}, ${meeting.project}).${item.owner ? ` Owner: ${item.owner}.` : ''}` };
}
