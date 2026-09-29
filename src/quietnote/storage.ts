import { invoke, isTauri } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import { saveFileDirect } from '../services/files';
import { getNotesFolder, setNotesFolder, searchNotes, startFileWatcher } from '../services/notes';
import type { Meeting, MeetingMetadata } from './model';
import { demoMeetings } from './seeds';
export const desktop = isTauri();
const key = 'quietnote.preview.archive.v1';
const projectsKey = 'quietnote.preview.projects.v1';
let archiveRoot = '';
export type PrivacyPreferences = Record<string, boolean | string>;
function browserMeetings(): Meeting[] {
  const saved = localStorage.getItem(key);
  return saved ? JSON.parse(saved) : [];
}
function writeBrowser(meetings: Meeting[]) { localStorage.setItem(key, JSON.stringify(meetings)); }
function browserProjects(): string[] { return JSON.parse(localStorage.getItem(projectsKey) ?? '[]'); }
type Archive = { root: string; projects: string[]; meetings: Meeting[] };
let pendingLoad: Promise<Archive> | null = null;
export function loadArchive(): Promise<Archive> {
  if (!pendingLoad) pendingLoad = readArchive().finally(() => { pendingLoad = null; });
  return pendingLoad;
}
async function readArchive(): Promise<Archive> {
  if (!desktop) {
    const meetings = browserMeetings();
    const projects = [...new Set([...browserProjects(), ...meetings.map(m => m.metadata.project)])].sort((a, b) => a.localeCompare(b));
    return { root: '', projects, meetings };
  }
  const archive = await invoke<Archive>('load_meeting_archive');
  archiveRoot = archive.root;
  if (await getNotesFolder() !== archiveRoot) await setNotesFolder(archiveRoot);
  await startFileWatcher();
  return archive;
}
// Paths QuietNote wrote recently, so watcher events for its own saves aren't reported as outside changes.
const ownWrites = new Map<string, number>();
const normalize = (path: string) => path.replace(/\\/g, '/');
export function noteWrite(...paths: string[]) { for (const path of paths) ownWrites.set(normalize(`${archiveRoot}/${path}`), Date.now()); }
export function isOwnWrite(path: string): boolean {
  const at = ownWrites.get(normalize(path));
  return at !== undefined && Date.now() - at < 4000;
}
export async function createProject(name: string): Promise<void> {
  if (desktop) { await invoke('create_project', { name: name.trim() }); return; }
  const projects = browserProjects();
  if (projects.some(p => p.toLowerCase() === name.trim().toLowerCase())) throw new Error('A project with this name already exists');
  localStorage.setItem(projectsKey, JSON.stringify([...projects, name.trim()]));
}
export async function createMeeting(meeting: Meeting): Promise<void> {
  if (desktop) {
    noteWrite(meeting.metadata.meetingPath, meeting.metadata.transcriptPath);
    await invoke('create_meeting_bundle', { meeting });
  } else {
    const existing = browserMeetings();
    if (existing.some(m => m.metadata.id === meeting.metadata.id)) throw new Error('Meeting already exists');
    writeBrowser([meeting, ...existing]);
  }
}
export async function addExamples(existing: string[]): Promise<void> {
  for (const meeting of demoMeetings) if (!existing.includes(meeting.metadata.id)) await createMeeting(meeting);
}
export async function saveMarkdown(metadata: MeetingMetadata, markdown: string): Promise<void> {
  if (desktop) { noteWrite(metadata.meetingPath); await saveFileDirect(`${archiveRoot}/${metadata.meetingPath}`, markdown); }
  else writeBrowser(browserMeetings().map(m => m.metadata.id === metadata.id ? { ...m, markdown } : m));
}
export async function saveMetadata(metadata: MeetingMetadata): Promise<void> {
  if (desktop) await invoke('save_meeting_metadata', { metadata });
  else writeBrowser(browserMeetings().map(m => m.metadata.id === metadata.id ? { ...m, metadata } : m));
}
export async function indexedSearch(query: string): Promise<string[]> {
  if (!desktop) return [];
  const results = await searchNotes(query);
  return results.map(r => r.id.split('/').slice(-2, -1)[0] ?? '');
}
export async function archiveLocation(): Promise<string> {
  return archiveRoot || (desktop ? join(await appDataDir(), 'meetings') : '');
}
export async function openArchive(): Promise<void> { await invoke('open_in_file_manager', { path: await archiveLocation() }); }
export async function preferences(value?: PrivacyPreferences): Promise<PrivacyPreferences> {
  if (desktop) return invoke('quietnote_preferences', { value: value ?? null });
  if (value) localStorage.setItem('quietnote.privacy', JSON.stringify(value));
  return JSON.parse(localStorage.getItem('quietnote.privacy') ?? '{}');
}
// Menu bar / tray (desktop only). The tray reads recent meetings and projects from disk; the app reports its current project.
export async function traySync(project: string): Promise<void> { if (desktop) await invoke('tray_sync', { project: project || null }); }
export async function quit(): Promise<void> { if (desktop) await invoke('quietnote_quit'); }
// Recording (desktop, macOS and Windows): Rust owns capture and transcription, so they continue while the
// window is hidden and the tray can stop them. The browser preview keeps the prototype capture.
export type Level = 'waiting' | 'heard' | 'silent';
export type CaptureState = {
  available: boolean;
  /** The OS microphone permission; system audio permission can't be read, so it's never claimed. */
  microphone: 'granted' | 'denied' | 'undetermined' | 'unknown';
  model: 'ready' | 'missing' | 'damaged';
  recording: {
    meetingId: string; title: string; startedAt: string; mic: Level; system: Level;
    micDevice: string | null; systemDevice: string | null; problem: string | null; note: string | null;
  } | null;
  transcribing: { meetingId: string; title: string; percent: number } | null;
  queued: string[];
};
export type MeetingChanged = { metadata: MeetingMetadata; transcript: string | null; problem: string | null };
export type TranscriptTurn = { startMs: number; speaker: string; text: string; clean: string };
/** Why Start recording failed: `mic-denied` offers System Settings, `disk` means free space first. */
export type CaptureFailure = { code: 'mic-denied' | 'disk' | 'failed'; message: string };
export const noCapture: CaptureState = { available: false, microphone: 'unknown', model: 'missing', recording: null, transcribing: null, queued: [] };
export async function captureStatus(): Promise<CaptureState> { return desktop ? invoke('capture_status') : noCapture; }
export async function captureStart(meetingId: string): Promise<MeetingMetadata> {
  try { return await invoke('capture_start', { meetingId }); }
  catch (e) { throw (typeof e === 'object' && e && 'code' in e ? e : { code: 'failed', message: String(e) }) as CaptureFailure; }
}
export async function captureStop(): Promise<MeetingMetadata> { return invoke('capture_stop'); }
export async function transcribe(meetingId: string): Promise<MeetingMetadata> { return invoke('transcribe_meeting', { meetingId }); }
/** Both views of a recorded transcript; reading them changes nothing. */
export async function transcriptData(meetingId: string): Promise<TranscriptTurn[] | null> { return desktop ? invoke('transcript_data', { meetingId }) : null; }
export async function renderTranscripts(clean: boolean): Promise<void> { if (desktop) await invoke('render_transcripts', { clean }); }
export async function openPrivacySettings(kind: 'microphone' | 'systemAudio'): Promise<void> { if (desktop) await invoke('open_privacy_settings', { kind }); }
export async function revealAudio(metadata: MeetingMetadata): Promise<void> {
  if (!desktop || !metadata.audioPath) return;
  // Explorer needs Windows separators; the archive's relative paths always use '/'.
  const path = `${archiveRoot}/${metadata.audioPath}`;
  await invoke('open_in_file_manager', { path: archiveRoot.includes('\\') ? path.replace(/\//g, '\\') : path });
}
// Connections: keys stay in the macOS Keychain on the Rust side. The browser preview can't connect.
export type Service = 'linear' | 'github';
export type Connections = Partial<Record<Service, { account: string }>>;
export type Target = { id: string; name: string };
export type Sent = { label: string | null; url: string | null; error: string | null };
const desktopOnly = () => Promise.reject(new Error('Available in the desktop app.'));
export async function connections(): Promise<Connections> { return desktop ? invoke('connector_status') : {}; }
export async function connect(service: Service, token: string): Promise<{ account: string }> { return desktop ? invoke('connector_connect', { service, token }) : desktopOnly(); }
export async function disconnect(service: Service): Promise<void> { return desktop ? invoke('connector_disconnect', { service }) : desktopOnly(); }
export async function connectorTargets(service: Service): Promise<Target[]> { return desktop ? invoke('connector_targets', { service }) : desktopOnly(); }
export async function sendIssues(service: Service, target: string, items: { title: string; body: string }[]): Promise<Sent[]> { return desktop ? invoke('connector_send', { service, target, items }) : desktopOnly(); }
let icons: Promise<Record<string, string>> | null = null;
export function appIcons(): Promise<Record<string, string>> { return desktop ? (icons ??= invoke('connector_app_icons')) : Promise.resolve({}); }
export async function openLink(url: string): Promise<void> {
  if (desktop) await invoke('open_url_safe', { url }); else window.open(url, '_blank', 'noopener');
}
