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
}
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
export function transcriptTurns(transcript: string): TranscriptTurn[] {
  return transcript.split(/^### /m).slice(1).map(chunk => {
    const [heading, ...body] = chunk.trim().split('\n');
    const [time, ...speaker] = heading.split(' ');
    return { time, speaker: speaker.join(' '), text: body.join('\n').trim() };
  });
}
export function matchesMeeting(meeting: Meeting, query: string): boolean {
  const haystack = [meeting.metadata.title, meeting.metadata.project, ...meeting.metadata.tags, ...meeting.metadata.participants, meeting.markdown, meeting.transcript].join(' ').toLowerCase();
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
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds)), pad = (n: number) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
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
export function makeMeeting(title: string, project: string): Meeting {
  const now = new Date().toISOString();
  const id = `${now.slice(0, 10)}-${crypto.randomUUID()}`;
  return {
    metadata: { id, title, project, date: now, duration: 0, participants: [], status: 'idle', captureStartedAt: null, captureEndedAt: null, audioPath: null, transcriptPath: `${project}/${id}/transcript.md`, meetingPath: `${project}/${id}/meeting.md`, tags: [] },
    markdown: `# ${title}\n\nDate: ${dateLabel(now)}\nProject: ${project}\n\n## Summary\n\n## Decisions\n\n## Action items\n\n## Notes\n`,
    transcript: '# Transcript\n',
  };
}
/** The issue that an action item becomes. Only the item, its owner and the meeting's title, date and project leave the device. */
export function issueFor(item: { text: string; owner: string }, meeting: { title: string; date: string; project: string }) {
  return { title: item.text, body: `From “${meeting.title}” (${meeting.date.slice(0, 10)}, ${meeting.project}).${item.owner ? ` Owner: ${item.owner}.` : ''}` };
}
