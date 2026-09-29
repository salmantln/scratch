import { invoke, isTauri } from '@tauri-apps/api/core';
import { saveFileDirect } from '../services/files';
import { getNotesFolder, setNotesFolder, searchNotes, startFileWatcher } from '../services/notes';
import type { Meeting, MeetingMetadata } from './model';
import { demoMeetings } from './seeds';
export const desktop = isTauri();
const key = 'quietnote.preview.archive.v1';
let archiveRoot = '';
export type PrivacyPreferences = Record<string, boolean | string>;
function browserMeetings(): Meeting[] {
  const saved = localStorage.getItem(key);
  return saved ? JSON.parse(saved) : structuredClone(demoMeetings);
}
function writeBrowser(meetings: Meeting[]) { localStorage.setItem(key, JSON.stringify(meetings)); }
type Archive = { root: string; meetings: Meeting[] };
let pendingLoad: Promise<Archive> | null = null;
export function loadArchive(): Promise<Archive> {
  if (!pendingLoad) pendingLoad = readArchive().finally(() => { pendingLoad = null; });
  return pendingLoad;
}
async function readArchive(): Promise<Archive> {
  if (!desktop) {
    const meetings = browserMeetings();
    writeBrowser(meetings);
    return { root: 'Browser preview · saved in this browser', meetings };
  }
  const archive = await invoke<{ root: string; meetings: Meeting[] }>('load_meeting_archive', { seeds: demoMeetings });
  archiveRoot = archive.root;
  if (await getNotesFolder() !== archiveRoot) await setNotesFolder(archiveRoot);
  await startFileWatcher();
  return archive;
}
export async function createMeeting(meeting: Meeting): Promise<void> {
  if (desktop) await invoke('create_meeting_bundle', { meeting });
  else {
    const existing = browserMeetings();
    if (existing.some(m => m.metadata.id === meeting.metadata.id)) throw new Error('Meeting already exists');
    writeBrowser([meeting, ...existing]);
  }
}
export async function saveMarkdown(metadata: MeetingMetadata, markdown: string): Promise<void> {
  if (desktop) await saveFileDirect(`${archiveRoot}/${metadata.meetingPath}`, markdown);
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
export async function preferences(value?: PrivacyPreferences): Promise<PrivacyPreferences> {
  if (desktop) return invoke('quietnote_preferences', { value: value ?? null });
  if (value) localStorage.setItem('quietnote.privacy', JSON.stringify(value));
  return JSON.parse(localStorage.getItem('quietnote.privacy') ?? '{}');
}
