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
function noteWrite(...paths: string[]) { for (const path of paths) ownWrites.set(normalize(`${archiveRoot}/${path}`), Date.now()); }
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
