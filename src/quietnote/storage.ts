import { getVersion } from '@tauri-apps/api/app';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import { saveFileDirect } from '../services/files';
import { getNotesFolder, setNotesFolder, searchNotes, startFileWatcher } from '../services/notes';
import type { CalendarEvent, Meeting, MeetingMetadata } from './model';
import { demoMeetings } from './seeds';
export const desktop = isTauri();
/** What the recording copy calls this computer. */
export const device = /Mac/.test(navigator.userAgent) ? 'Mac' : 'PC';
const key = 'quietnote.preview.archive.v1';
const projectsKey = 'quietnote.preview.projects.v1';
let archiveRoot = '';
export type PrivacyPreferences = Record<string, boolean | string | string[]>;
/** Settings → Appearance → Theme: light, dark, or the computer's own (the default). */
export type Appearance = 'system' | 'light' | 'dark';
export const appearance = (p: PrivacyPreferences): Appearance => p.theme === 'light' || p.theme === 'dark' ? p.theme : 'system';
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
    /** Recorded time before `resumedAt`; `resumedAt` is null while paused. See `model.recorded`. */
    recordedMs: number; resumedAt: string | null;
    micDevice: string | null; systemDevice: string | null; problem: string | null; note: string | null;
    /** The live transcript: loading the model, following the recording, off, or failed (the full transcript still comes after Stop). */
    liveText: LiveText;
    /** About to stop by itself (the call ended, or a long silence), unless kept. */
    ending?: { reason: string; stopsAt: string } | null;
  } | null;
  transcribing: { meetingId: string; title: string; percent: number } | null;
  queued: string[];
  /** QuietNote offers to record when a call app uses the microphone (macOS). */
  detectsCalls?: boolean;
  /** Recordings can show a live transcript on this platform (macOS). */
  liveTranscript?: boolean;
};
export type LiveText = 'off' | 'loading' | 'on' | 'failed';
/** The live transcript so far: a draft made on this device, replaced by the full transcript after Stop. */
export type Draft = { meetingId: string; turns: TranscriptTurn[] };
export async function liveTranscript(): Promise<Draft | null> { return desktop ? invoke('capture_live_transcript') : null; }
/** The compact window beside a call, or back to the full window where it was. */
export async function windowCompact(compact: boolean): Promise<void> { if (desktop) await invoke('window_compact', { compact }); }
export type MeetingChanged = { metadata: MeetingMetadata; transcript: string | null; problem: string | null };
export type TranscriptTurn = { startMs: number; speaker: string; text: string; clean: string };
/** Why Start recording failed: `mic-denied` offers System Settings, `disk` means free space first. */
export type CaptureFailure = { code: 'mic-denied' | 'disk' | 'failed'; message: string };
export const noCapture: CaptureState = { available: false, microphone: 'unknown', model: 'missing', recording: null, transcribing: null, queued: [] };
export async function captureStatus(): Promise<CaptureState> { return desktop ? invoke('capture_status') : noCapture; }
/** Asks for the microphone before any recording, so the first-run screens can explain it first. Records nothing. */
export async function allowMicrophone(): Promise<CaptureState> { return desktop ? invoke('capture_allow_microphone') : noCapture; }
const failure = (e: unknown) => (typeof e === 'object' && e && 'code' in e ? e : { code: 'failed', message: String(e) }) as CaptureFailure;
export async function captureStart(meetingId: string): Promise<MeetingMetadata> {
  try { return await invoke('capture_start', { meetingId }); } catch (e) { throw failure(e); }
}
export async function captureStop(): Promise<MeetingMetadata> { return invoke('capture_stop'); }
/** Pausing closes the streams, so the microphone is released until Resume. */
export async function capturePause(): Promise<void> { await invoke('capture_pause'); }
/** Keeps recording when it's about to stop by itself. */
export async function captureKeep(): Promise<void> { await invoke('capture_keep'); }
export async function captureResume(): Promise<void> { try { await invoke('capture_resume'); } catch (e) { throw failure(e); } }
/** The microphones to record from; `selected` null means the system default. */
export type Devices = { devices: string[]; selected: string | null };
export async function captureDevices(): Promise<Devices> { return desktop ? invoke('capture_devices') : { devices: [], selected: null }; }
export async function setCaptureDevice(name: string | null): Promise<void> { if (desktop) await invoke('capture_set_device', { name }); }
export async function transcribe(meetingId: string): Promise<MeetingMetadata> { return invoke('transcribe_meeting', { meetingId }); }
/** Both views of a recorded transcript; reading them changes nothing. */
export async function transcriptData(meetingId: string): Promise<TranscriptTurn[] | null> { return desktop ? invoke('transcript_data', { meetingId }) : null; }
export async function renderTranscripts(clean: boolean): Promise<void> { if (desktop) await invoke('render_transcripts', { clean }); }
/** The Terminal command that installs the read-only `quietnote` command (desktop, macOS). */
export async function cliSetupCommand(): Promise<string> { return desktop ? invoke('cli_setup_command') : desktopOnly(); }
/** The Calendar permission ("granted", "denied", "restricted", "undetermined", "unavailable"); `ask` shows macOS's prompt first. */
export async function calendarAccess(ask: boolean): Promise<string> { return desktop ? invoke('calendar_access', { ask }) : 'unavailable'; }
/** Today's and the coming `days`' events, soonest first, while Calendar is on. */
export async function calendarEvents(days = 1): Promise<CalendarEvent[]> { return desktop ? invoke('calendar_events', { days }) : []; }
/** The event the user is in or about to join. */
export async function calendarNow(): Promise<CalendarEvent | null> { return desktop ? invoke('calendar_now') : null; }
/** The configuration that lets an AI app (Claude Desktop, Claude Code) read the archive through `quietnote mcp`. */
export async function mcpConfig(): Promise<string> { return desktop ? invoke('mcp_config') : desktopOnly(); }
/** An AI app on this computer and whether its MCP settings run this copy of QuietNote ("other": a `quietnote` server that runs something else). */
export type Agent = { id: string; name: string; state: 'on' | 'off' | 'other' | 'unreadable'; path: string; problem: string | null };
export async function mcpAgents(): Promise<Agent[]> { return desktop ? invoke('mcp_agents') : []; }
/** Adds QuietNote to (or removes it from) that app's MCP settings file. */
export async function setMcpAgent(id: string, on: boolean): Promise<Agent> { return invoke('mcp_agent_set', { id, on }); }
export async function openPrivacySettings(kind: 'microphone' | 'systemAudio' | 'accessibility' | 'calendars'): Promise<void> { if (desktop) await invoke('open_privacy_settings', { kind }); }
/** Whether QuietNote may read browser window and tab titles (macOS Accessibility); `ask` shows macOS's prompt first. */
export async function callAccessibility(ask: boolean): Promise<boolean> { return desktop ? invoke('call_accessibility', { ask }) : false; }
/** Start recording from any app: Rust registers the accelerator ('' turns it off) and refuses one another app holds. */
export async function setGlobalShortcut(accelerator: string): Promise<void> { if (desktop) await invoke('hotkey_set', { accelerator }); }
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
/** The services this build signs in to through the browser; the others take a pasted key. */
export async function signInServices(): Promise<Service[]> { return desktop ? invoke('connector_sign_in_services') : []; }
/** Sent while signing in: the page to open, and for GitHub the code to type there. */
export type SigningIn = { service: Service; url: string; code: string | null; opened: boolean };
export async function signIn(service: Service): Promise<{ account: string }> { return desktop ? invoke('connector_sign_in', { service }) : desktopOnly(); }
export async function cancelSignIn(service: Service): Promise<void> { if (desktop) await invoke('connector_sign_in_cancel', { service }); }
export async function disconnect(service: Service): Promise<void> { return desktop ? invoke('connector_disconnect', { service }) : desktopOnly(); }
export async function connectorTargets(service: Service): Promise<Target[]> { return desktop ? invoke('connector_targets', { service }) : desktopOnly(); }
export async function sendIssues(service: Service, target: string, items: { title: string; body: string }[]): Promise<Sent[]> { return desktop ? invoke('connector_send', { service, target, items }) : desktopOnly(); }
let icons: Promise<Record<string, string>> | null = null;
export function appIcons(): Promise<Record<string, string>> { return desktop ? (icons ??= invoke('connector_app_icons')) : Promise.resolve({}); }
export async function openLink(url: string): Promise<void> {
  if (desktop) await invoke('open_url_safe', { url }); else window.open(url, '_blank', 'noopener');
}
// Give feedback: a new message in the mail app with only the version and computer filled in; nothing is sent until the
// user sends it.
const feedbackTo = 'sarl.the.developer@gmail.com';
export async function giveFeedback(): Promise<void> {
  const version = desktop ? await getVersion().catch(() => '') : '';
  const body = `\n\n—\nQuietNote ${version || 'browser preview'} on ${device}`;
  await openLink(`mailto:${feedbackTo}?subject=${encodeURIComponent('QuietNote feedback')}&body=${encodeURIComponent(body)}`);
}
// Licenses (macOS): an optional supporter or commercial license that unlocks nothing. Its key is checked once with
// Lemon Squeezy, then kept in the Keychain. Checkout links are set at build time; without them the buy buttons are hidden.
export type License = { kind: 'supporter' | 'commercial'; name: string; seats?: number; activatedAt: string; expiresAt?: string };
export type LicenseStatus = { available: boolean; license: License | null };
const link = (url: string | undefined) => url?.startsWith('https://') ? url : undefined;
export const checkout = { supporter: link(import.meta.env.VITE_QUIETNOTE_CHECKOUT_SUPPORTER), commercial: link(import.meta.env.VITE_QUIETNOTE_CHECKOUT_COMMERCIAL) };
export async function licenseStatus(): Promise<LicenseStatus> { return desktop ? invoke('license_status') : { available: false, license: null }; }
export async function activateLicense(key: string): Promise<License> { return desktop ? invoke('license_activate', { key }) : desktopOnly(); }
/** Resolves with a note when Lemon Squeezy couldn't be told; the license is removed from this computer either way. */
export async function removeLicense(): Promise<string | null> { return desktop ? invoke('license_remove') : desktopOnly(); }
// Summary suggestions (desktop): drafted from the transcript by Claude with the user's own key, or by a model in
// Ollama on this computer. The key stays in the Keychain; nothing is written until the user accepts an item.
export type SummaryProvider = 'anthropic' | 'ollama';
/** A suggested action item and the transcript line it cites. */
export type Cited = { text: string; owner: string; atMs: number; quote: string };
/** `dropped` counts the items left out because they couldn't be traced to the transcript. */
export type Suggestions = { summary: string; actions: Cited[]; dropped: number };
export async function summaryKeySaved(): Promise<boolean> { return desktop ? invoke('summary_key_status') : false; }
export async function saveSummaryKey(key: string): Promise<void> { return desktop ? invoke('summary_set_key', { key }) : desktopOnly(); }
export async function removeSummaryKey(): Promise<void> { return desktop ? invoke('summary_remove_key') : desktopOnly(); }
export async function ollamaModels(): Promise<string[]> { return desktop ? invoke('summary_ollama_models') : desktopOnly(); }
export async function suggestSummary(meetingId: string): Promise<Suggestions> { return desktop ? invoke('summary_suggest', { meetingId }) : desktopOnly(); }
/** A template's sections, each with what belongs in it. The user's own live in the archive's `.templates` folder. */
export type NoteTemplate = { name: string; sections: { heading: string; description: string }[]; builtIn: boolean };
/** Enhanced notes: lines quoting the transcript (`atMs`) or the user's own notes (`atMs` null). */
export type Enhanced = { sections: { heading: string; lines: { text: string; atMs: number | null; quote: string }[] }[]; dropped: number };
export async function noteTemplates(): Promise<NoteTemplate[]> { return desktop ? invoke('note_templates') : []; }
export async function openTemplates(): Promise<void> { return desktop ? invoke('open_templates') : desktopOnly(); }
/** A suggested title and names for a recorded meeting's voices, each name with the line that shows it. */
export type Names = { title: string; speakers: { speaker: string; name: string; atMs: number; quote: string }[]; dropped: number };
export async function meetingNames(meetingId: string): Promise<Names> { return desktop ? invoke('meeting_names', { meetingId }) : desktopOnly(); }
/** Names a voice in a recorded transcript (or merges it into another); returns the transcript as written. */
export async function renameSpeaker(meetingId: string, from: string, to: string): Promise<string> { return desktop ? invoke('transcript_rename_speaker', { meetingId, from, to }) : desktopOnly(); }
export async function enhanceNotes(meetingId: string, template: string): Promise<Enhanced> { return desktop ? invoke('notes_enhance', { meetingId, template }) : desktopOnly(); }
