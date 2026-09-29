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
}
export interface Meeting { metadata: MeetingMetadata; markdown: string; transcript: string }
export const projects = ['Acme', 'Northstar', 'Internal', 'Personal'];
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
export function matchesMeeting(meeting: Meeting, query: string): boolean {
  const haystack = [meeting.metadata.title, meeting.metadata.project, ...meeting.metadata.tags, ...meeting.metadata.participants, meeting.markdown, meeting.transcript].join(' ').toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every(term => haystack.includes(term));
}
export function dateLabel(date: string): string {
  return new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function durationLabel(seconds: number): string { return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`; }
export function makeMeeting(title: string, project: string): Meeting {
  const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}`;
  return {
    metadata: { id, title, project, date: new Date().toISOString(), duration: 0, participants: ['You'], status: 'idle', captureStartedAt: null, captureEndedAt: null, audioPath: null, transcriptPath: `${project}/${id}/transcript.md`, meetingPath: `${project}/${id}/meeting.md`, tags: ['Prototype'] },
    markdown: `# ${title}\n\nDate: ${dateLabel(new Date().toISOString())}\nProject: ${project}\n\n## Summary\nThis is a prototype capture. No audio has been recorded or transcribed.\n\n## Decisions\n\n## Action items\n\n## Notes\n`,
    transcript: '# Transcript\n\nPrototype capture — no audio was recorded. Add manual notes in the Notes tab.\n',
  };
}
