import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type SyntheticEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { ThemeProvider, useTheme } from '../context/ThemeContext';
import { Toaster, toast } from 'sonner';
import { TooltipProvider } from '../components/ui';
import { SidebarResizeHandle } from '../components/layout/SidebarResizeHandle';
import { Folder, Icon } from './Icon';
import { Hush, HushYield, showHush } from './Hush';
import { DeleteMeetingDialog, NewMeetingDialog, NewProjectDialog } from './Dialogs';
import { ConnectionsDialog, SendDialog, type IssueLink } from './Connectors';
import { Settings, SettingsNav, diskAtRisk, settingsSections, useDisk, type SettingsSection } from './Settings';
import { MeetingDetail } from './MeetingDetail';
import { People } from './People';
import { ActionItems, Home, MeetingList } from './Library';
import { Onboarding } from './Onboarding';
import { LicenseDialog } from './License';
import { accelerator, bound, label, type Action } from './shortcuts';
import { actionItems, actionLine, clock, editAction, removeAction, restoreAction, linkAction, recorded, makeMeeting, openingTab, previousMeeting, projectFor, reproject, retitle, replaceSection, searchMeeting, searchTerms, section, shortDate, stopsIn, toggleAction, type ActionItem, type CalendarEvent, type Meeting, type MeetingTab } from './model';
import { demoMeetings, isExample } from './seeds';
import * as storage from './storage';
import './quietnote.css';

type View = 'home' | 'all' | 'actions' | 'project' | 'meeting' | 'search' | 'settings' | 'people';
type Place = { view: View; project: string; selected: string; tab: MeetingTab; section: SettingsSection; person: string };
const placeKey = 'quietnote.place.v1';
const lastProjectKey = 'quietnote.lastProject';
const railKey = 'quietnote.rail';
// Narrow windows always show the sidebar as icons only.
const narrowWindow = window.matchMedia('(max-width: 720px)');
const watchNarrow = (change: () => void) => { narrowWindow.addEventListener('change', change); return () => narrowWindow.removeEventListener('change', change); };
const onDivider = (e: SyntheticEvent) => Boolean((e.target as HTMLElement).closest('.qn-sidebar > [role="separator"]'));
function remembered<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; } }
function remember(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Per-viewer convenience only. */ } }
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  // The whole phrase is tried first so "phase two" highlights as one match.
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(${[terms.join(' '), ...terms].map(escape).join('|')})`, 'gi');
  return <>{text.split(pattern).map((part, i) => i % 2 ? <mark key={i}>{part}</mark> : part)}</>;
}
/** Shown in every view while recording, so "is QuietNote recording?" always has an answer. The recording meeting has its own recorder bar instead. */
function RecordingBar({ recording, onOpen, onStop, onResume, onKeep }: { recording: NonNullable<storage.CaptureState['recording']>; onOpen: () => void; onStop: () => void; onResume: () => void; onKeep: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const paused = recording.resumedAt === null;
  useEffect(() => { if (paused) return; const timer = window.setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, [paused]);
  const elapsed = clock(recorded(recording, now));
  const label = paused ? 'Paused' : 'Recording';
  return <div className={`recording-bar ${paused ? 'paused' : ''}`} role="group" aria-label={`${label} ${recording.title}, ${elapsed}`}>
    <i className={paused ? 'paused-dot' : 'live-dot'} aria-hidden="true" /><span className="recording-label">{label}</span>
    <button className="text-button recording-title" title="Open meeting" onClick={onOpen}>{recording.title}</button>
    <span className="recording-time" aria-hidden="true">{elapsed}</span>
    {recording.problem && <span className="recording-problem" role="img" aria-label={recording.problem} title={recording.problem}><Icon name="info" size={14} /></span>}
    {recording.ending && <><span className="recording-ending" role="status">{recording.ending.reason} {stopsIn(recording.ending.stopsAt, now)}.</span><button className="text-button" onClick={onKeep}>Keep recording</button></>}
    {paused && <button className="text-button" onClick={onResume}>Resume</button>}
    <button className="text-button" aria-label="Stop recording" title="Stop recording" onClick={onStop}>Stop</button>
  </div>;
}
function Shell() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const records = useRef<Meeting[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [root, setRoot] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [unsaved, setUnsaved] = useState<'' | 'failed' | 'recovered'>('');
  const [saveDetail, setSaveDetail] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [external, setExternal] = useState(false);
  const [problem, setProblem] = useState('');
  const initial = useMemo(() => remembered<Partial<Place>>(placeKey, {}), []);
  // Home replaced Recent; a place remembered from before still opens there.
  const [view, setView] = useState<View>(!initial.view || (initial.view as string) === 'recent' ? 'home' : initial.view);
  const [project, setProject] = useState(initial.project ?? '');
  const [selected, setSelected] = useState(initial.selected ?? '');
  // On People: a person's key or `@domain`, or nobody (the list).
  const [person, setPerson] = useState(initial.person ?? '');
  // Summary, Decisions and Action items were tabs in earlier builds; they're in the enhanced notes now.
  const [tab, setTab] = useState<MeetingTab>(initial.tab === 'Notes' || initial.tab === 'Transcript' ? initial.tab : 'Enhanced');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(initial.section ?? 'General');
  const [query, setQuery] = useState('');
  const [indexedIds, setIndexedIds] = useState<string[]>([]);
  const [dialog, setDialog] = useState<'' | 'project' | 'meeting' | 'connections' | 'send' | 'delete' | 'license'>('');
  // The subscription (builds that sell one): a recording asked for without one that allows it waits in
  // `afterLicense` while the license dialog explains, and starts once a key is activated or checked.
  const [license, setLicense] = useState<storage.LicenseStatus>(storage.unlicensed);
  const licenseNow = useRef(license);
  licenseNow.current = license;
  const afterLicense = useRef<(() => void) | null>(null);
  // The meeting whose recording was asked for: its recorder strip starts it (or explains first, unless the
  // call panel's Record asked: that press is the start, as in Granola, and macOS asks for the microphone itself).
  const [capture, setCapture] = useState<{ id: string; call: boolean } | null>(null);
  const [live, setLive] = useState<storage.CaptureState>(storage.noCapture);
  // New meeting asked for before any project existed: it opens once the project is created.
  const [meetingNext, setMeetingNext] = useState(false);
  const [stopped, setStopped] = useState<{ id: string; title: string } | null>(null);
  const [recoverySeen, setRecoverySeen] = useState<string[]>([]);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  // The sidebar as icons only, or icons with labels: double-clicking its divider switches.
  const [rail, setRail] = useState(() => remembered(railKey, false));
  useEffect(() => { remember(railKey, rail); }, [rail]);
  const narrow = useSyncExternalStore(watchNarrow, () => narrowWindow.matches);
  const [addingExamples, setAddingExamples] = useState(false);
  // Development only: VITE_QUIETNOTE_ONBOARDING=1 (or ?onboarding in the browser preview) opens onboarding over an
  // archive that already has meetings, until it's finished.
  const [replay, setReplay] = useState(() => import.meta.env.DEV && (import.meta.env.VITE_QUIETNOTE_ONBOARDING === '1' || new URLSearchParams(location.search).has('onboarding')));
  // Onboarding stays on screen after it creates the first project, for its last screen (your name).
  const [finishing, setFinishing] = useState(false);
  const [preferences, setPreferences] = useState<storage.PrivacyPreferences>({});
  useEffect(() => showHush(preferences.showHush !== false), [preferences.showHush]);
  // The theme is Scratch's own light and dark (the `.dark` class, which its editor follows too), set once the
  // preferences are read; on macOS the native window, its menus and the call panel follow the same choice.
  const { theme, setTheme } = useTheme();
  const appearance = storage.appearance(preferences);
  useEffect(() => { if (!loading && theme !== appearance) setTheme(appearance); }, [loading, appearance, theme, setTheme]);
  useEffect(() => { if (storage.desktop && !loading) getCurrentWindow().setTheme(appearance === 'system' ? null : appearance).catch(() => { /* The page still follows it. */ }); }, [loading, appearance]);
  const [connections, setConnections] = useState<storage.Connections>({});
  const [summaryKey, setSummaryKey] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const dirty = useRef(new Map<string, string>());
  const queue = useRef(Promise.resolve());
  const searchInput = useRef<HTMLInputElement>(null);
  const main = useRef<HTMLElement>(null);
  const setRecords = useCallback((next: Meeting[]) => { records.current = next; setMeetings(next); }, []);
  const upsert = useCallback((meeting: Meeting) => { setRecords([meeting, ...records.current.filter(m => m.metadata.id !== meeting.metadata.id)]); }, [setRecords]);
  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const archive = await storage.loadArchive();
      // Recover drafts left by a failed save or an interrupted session.
      let recovered = false;
      const restored = archive.meetings.map(m => {
        const draft = localStorage.getItem(`quietnote.draft.${m.metadata.id}`);
        const meeting = draft === null ? m : { ...m, markdown: draft };
        if (draft !== null) { dirty.current.set(m.metadata.id, draft); recovered = true; }
        // On desktop, Rust recovers interrupted recordings at launch; the preview has nothing to recover.
        if (!storage.desktop && (m.metadata.status === 'recording' || m.metadata.status === 'processing')) return { ...meeting, metadata: { ...meeting.metadata, status: 'error' as const } };
        return meeting;
      });
      setRoot(archive.root); setProjects(archive.projects); setRecords(restored);
      if (recovered) { setUnsaved('recovered'); setSaveState('unsaved'); }
      setPreferences(await storage.preferences());
      await storage.captureStatus().then(setLive).catch(() => { /* Recording controls stay hidden. */ });
      storage.connections().then(setConnections).catch(e => setProblem(`Couldn’t read your connections. ${String(e)}`));
      storage.summaryKeySaved().then(setSummaryKey).catch(() => setSummaryKey(false));
    } catch (e) { setLoadError(String(e)); }
    finally { setLoading(false); }
  }, [setRecords]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { remember(placeKey, { view, project, selected, tab, section: settingsSection, person }); }, [view, project, selected, tab, settingsSection, person]);
  useEffect(() => { main.current?.scrollTo(0, 0); }, [selected, view, project, tab]);
  useEffect(() => { if (view === 'search') searchInput.current?.focus(); }, [view]);
  useEffect(() => {
    let cancelled = false;
    setIndexedIds([]);
    if (!query.trim()) return;
    const timer = window.setTimeout(() => { storage.indexedSearch(query).then(ids => { if (!cancelled) setIndexedIds(ids); }).catch(() => { /* Local full-content matching still applies. */ }); }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);
  // Watcher events prompt an explicit refresh; QuietNote's own saves are ignored.
  useEffect(() => {
    if (!storage.desktop) return;
    let cancelled = false; let unlisten: (() => void) | undefined;
    listen<{ path: string }>('file-change', event => { if (!storage.isOwnWrite(event.payload.path)) setExternal(true); }).then(fn => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);
  // Recording and transcription run in Rust: follow their state, and take meeting updates (status,
  // a finished transcript) as they happen. Rust's transcript writes aren't outside changes.
  useEffect(() => {
    if (!storage.desktop) return;
    let cancelled = false; const unlisten: (() => void)[] = [];
    const keep = (fn: () => void) => { if (cancelled) fn(); else unlisten.push(fn); };
    listen<storage.CaptureState>('quietnote://capture-state', event => setLive(event.payload)).then(keep);
    // The tray's Pause, Resume and Stop run in Rust; if one fails, the window says why.
    listen<string>('quietnote://capture-problem', event => setProblem(event.payload)).then(keep);
    listen<storage.MeetingChanged>('quietnote://meeting-changed', ({ payload }) => {
      if (payload.transcript !== null) storage.noteWrite(payload.metadata.transcriptPath);
      const existing = records.current.find(m => m.metadata.id === payload.metadata.id);
      if (existing) upsert({ ...existing, metadata: payload.metadata, transcript: payload.transcript ?? existing.transcript });
      if (payload.problem) setProblem(payload.problem);
    }).then(keep);
    return () => { cancelled = true; unlisten.forEach(fn => fn()); };
  }, [upsert]);
  // However a recording stops (recorder, window bar, tray, low disk), say that it was saved and where it went.
  const lastRecording = useRef(live.recording);
  useEffect(() => {
    const previous = lastRecording.current; lastRecording.current = live.recording;
    if (live.recording) setStopped(null);
    else if (previous) { setStopped({ id: previous.meetingId, title: previous.title }); setCapture(c => c?.id === previous.meetingId ? null : c); }
  }, [live.recording]);
  const updateMetadata = useCallback((metadata: Meeting['metadata']) => {
    const existing = records.current.find(m => m.metadata.id === metadata.id);
    if (existing) upsert({ ...existing, metadata });
  }, [upsert]);
  async function captureAction(action: () => Promise<Meeting['metadata']>, failure: string) {
    try { updateMetadata(await action()); } catch (e) { setProblem(`${failure} ${String(e).replace(/^Error: /, '')}`); }
  }
  async function exportAudio(meeting: Meeting) {
    try { const folder = await storage.exportAudio(meeting.metadata); if (folder) toast(`Exported the audio to “${folder.split(/[\\/]/).filter(Boolean).pop() ?? folder}”`); }
    catch (e) { setProblem(`Couldn’t export the audio. ${String(e).replace(/^Error: /, '')}`); }
  }
  async function dismissRecovered(meeting: Meeting) {
    const next = { ...meeting, metadata: { ...meeting.metadata, interrupted: false } };
    try { await storage.saveMetadata(next.metadata); upsert(next); }
    catch (e) { setProblem(`Couldn’t update this meeting. ${String(e)}`); }
  }
  const persist = useCallback((id: string, markdown: string) => {
    const meeting = records.current.find(m => m.metadata.id === id);
    if (!meeting) return Promise.resolve();
    try { localStorage.setItem(`quietnote.draft.${id}`, markdown); }
    catch { setProblem('A backup of your draft couldn’t be kept. Keep this window open until saving finishes.'); }
    dirty.current.set(id, markdown);
    upsert({ ...meeting, markdown }); setSaveState('saving');
    queue.current = queue.current.then(async () => {
      try {
        // Where the meeting is when its turn comes: a move queued before this save changed its paths.
        await storage.saveMarkdown(records.current.find(m => m.metadata.id === id)?.metadata ?? meeting.metadata, markdown);
        if (dirty.current.get(id) === markdown) { dirty.current.delete(id); localStorage.removeItem(`quietnote.draft.${id}`); }
        if (!dirty.current.size) { setSaveState('saved'); setUnsaved(''); setConfirmDiscard(false); }
      } catch (e) { setSaveState('unsaved'); setUnsaved('failed'); setSaveDetail(String(e)); }
    });
    return queue.current;
  }, [upsert]);
  // Closing hides the window (Rust side) and QuietNote stays in the menu bar; pending notes are saved on the way.
  // Quit QuietNote from the tray saves them too, then exits.
  useEffect(() => {
    if (!storage.desktop) return;
    const flush = async () => { await Promise.all([...dirty.current].map(([id, markdown]) => persist(id, markdown))); await queue.current; };
    let cancelled = false; const unlisten: (() => void)[] = [];
    const keep = (fn: () => void) => { if (cancelled) fn(); else unlisten.push(fn); };
    getCurrentWindow().onCloseRequested(event => { event.preventDefault(); void flush(); }).then(keep);
    listen('quietnote://quit-requested', () => { void flush().finally(() => void storage.quit()); }).then(keep);
    return () => { cancelled = true; unlisten.forEach(fn => fn()); };
  }, [persist]);
  function backupNotes(id: string, notes: string) {
    const meeting = records.current.find(m => m.metadata.id === id);
    if (!meeting) return;
    const markdown = replaceSection(meeting.markdown, 'Notes', notes);
    dirty.current.set(id, markdown); setSaveState('saving');
    try { localStorage.setItem(`quietnote.draft.${id}`, markdown); }
    catch { setProblem('A backup of your draft couldn’t be kept. Keep this window open until saving finishes.'); }
  }
  async function retry() { await Promise.all([...dirty.current].map(([id, markdown]) => persist(id, markdown))); }
  async function discard() {
    await queue.current;
    for (const id of dirty.current.keys()) localStorage.removeItem(`quietnote.draft.${id}`);
    dirty.current.clear(); setUnsaved(''); setConfirmDiscard(false); setSaveState('saved');
    await load(); setReloadKey(v => v + 1);
  }
  async function reload() {
    await queue.current;
    if (dirty.current.size) { setProblem('Save or discard your unsaved changes before reloading.'); return; }
    await load(); setExternal(false); setReloadKey(v => v + 1);
  }
  // Two changes in a row (onboarding's template and name) each build on the one before.
  const latestPreferences = useRef(preferences); latestPreferences.current = preferences;
  function changePreference(key: string, value: storage.PrivacyPreferences[string]) {
    const next = { ...latestPreferences.current, [key]: value }; latestPreferences.current = next; setPreferences(next);
    queue.current = queue.current.then(async () => {
      try { await storage.preferences(next); } catch (e) { setProblem(`Couldn’t save your privacy preferences. ${String(e)}`); return; }
      if (key === 'cleanTranscript') await storage.renderTranscripts(value === true).catch(e => setProblem(`Couldn’t update your transcripts. ${String(e)}`));
    });
  }
  // Suggestions need recording (a transcript to read) and a model that's ready to use.
  const summarizer = useMemo(() => {
    if (!live.available) return null;
    if (preferences.summaryProvider === 'anthropic') return summaryKey ? { local: false, label: 'Claude' } : null;
    const model = preferences.summaryProvider === 'ollama' ? preferences.ollamaModel : '';
    return typeof model === 'string' && model ? { local: true, label: model } : null;
  }, [live.available, preferences.summaryProvider, preferences.ollamaModel, summaryKey]);
  const go = useCallback((next: View, nextProject = '') => { setView(next); setProject(nextProject); }, []);
  // Where Back to meetings returns to: the last place outside Settings.
  const beforeSettings = useRef<{ view: View; project: string }>({ view: 'home', project: '' });
  useEffect(() => { if (view !== 'settings') beforeSettings.current = { view, project }; }, [view, project]);
  // FileVault, read while Settings is open: Privacy warns, and its nav item has a dot, while the disk isn't encrypted.
  const disk = useDisk(view === 'settings');
  const [find, setFind] = useState('');
  const openMeeting = useCallback((id: string, nextTab?: MeetingTab, nextFind = '') => {
    const meeting = records.current.find(m => m.metadata.id === id);
    setSelected(id); setTab(nextTab ?? (meeting ? openingTab(meeting) : 'Notes')); setFind(nextFind); setView('meeting');
  }, []);
  useEffect(() => { if (view === 'meeting' && stopped?.id === selected) setStopped(null); }, [view, selected, stopped]);
  // A start that's still waiting (first-run explanation, a permission problem) is dropped on leaving its meeting.
  useEffect(() => { setCapture(c => c && (view !== 'meeting' || selected !== c.id) ? null : c); }, [view, selected]);
  const sorted = useMemo(() => [...meetings].sort((a, b) => b.metadata.date.localeCompare(a.metadata.date)), [meetings]);
  const allProjects = useMemo(() => [...new Set([...projects, ...meetings.map(m => m.metadata.project)])].sort((a, b) => a.localeCompare(b)), [projects, meetings]);
  const current = meetings.find(m => m.metadata.id === selected);
  const previous = useMemo(() => current ? previousMeeting(current, meetings, isExample) : null, [current, meetings]);
  const contextProject = view === 'project' ? project : view === 'meeting' && current ? current.metadata.project : remembered(lastProjectKey, '');
  // The calendar (macOS, while it's on): today's events, for Home, New meeting and recording a call.
  const calendarOn = storage.desktop && preferences.calendar === true;
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  useEffect(() => {
    if (!calendarOn) { setEvents([]); return; }
    let cancelled = false;
    const read = () => { storage.calendarEvents(1).then(e => { if (!cancelled) setEvents(e); }).catch(() => { /* The calendar only fills things in. */ }); };
    // Just turned on: Rust reads the preference, so the first read waits for it to be saved.
    void queue.current.then(read);
    const timer = window.setInterval(read, 60_000);
    window.addEventListener('focus', read);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', read); };
  }, [calendarOn]);
  const fallbackProject = allProjects.includes(contextProject) ? contextProject : allProjects[0];
  const projectOf = useCallback((event: CalendarEvent) => projectFor(event, meetings, fallbackProject), [meetings, fallbackProject]);
  // New meeting from an event, or without one the event happening now fills it in once it's found.
  const [meetingEvent, setMeetingEvent] = useState<CalendarEvent | null>(null);
  const newMeeting = useCallback((event: CalendarEvent | null = null) => {
    setMeetingEvent(event);
    if (!event && calendarOn) storage.calendarNow().then(now => { if (now) setMeetingEvent(e => e ?? now); }).catch(() => { /* Then it's a plain new meeting. */ });
    setMeetingNext(!allProjects.length); setDialog(allProjects.length ? 'meeting' : 'project');
  }, [allProjects.length, calendarOn]);
  const results = useMemo(() => {
    if (!query.trim()) return [];
    return sorted.flatMap(meeting => {
      const hit = searchMeeting(meeting, query) ?? (indexedIds.includes(meeting.metadata.id) ? { tab: openingTab(meeting), snippet: section(meeting.markdown, 'Summary').slice(0, 160) } : null);
      return hit ? [{ meeting, ...hit }] : [];
    });
  }, [sorted, query, indexedIds]);
  // A stale remembered place (deleted meeting or project) falls back to Home.
  useEffect(() => {
    if (loading) return;
    if ((view === 'meeting' && !current) || (view === 'project' && !allProjects.includes(project))) go('home');
  }, [loading, view, current, project, allProjects, go]);
  // The compact window: a call recorded from the panel gets a narrow column beside the call with just the
  // meeting, like a notepad next to it. Rust sizes the window; leaving puts it back where it was.
  const [compact, setCompact] = useState(false);
  const setWindowCompact = useCallback((on: boolean) => {
    setCompact(on);
    storage.windowCompact(on).catch(e => setProblem(`Couldn’t resize the window. ${String(e)}`));
  }, []);
  // Going anywhere but the meeting (a shortcut, the tray) brings the full window back.
  useEffect(() => { if (compact && view !== 'meeting') setWindowCompact(false); }, [compact, view, setWindowCompact]);
  const blocked = Boolean(dialog);
  // Tray actions arrive after Rust has shown the window. An open dialog is never replaced.
  // The call panel's Record: a meeting named after the app, recording at once. Without a project yet,
  // New meeting asks for one.
  // With the calendar on, the meeting is named after the event the user is in, and knows who's invited.
  async function recordCall(app: string) {
    if (live.recording) { openMeeting(live.recording.meetingId, 'Notes'); setWindowCompact(true); return; }
    if (held(() => void trayActions.current.recordCall(app))) return;
    if (!allProjects.length) { newMeeting(); return; }
    const event = calendarOn ? await storage.calendarNow().catch(() => null) : null;
    createMeeting(event?.title ?? `${app} call`, event ? projectOf(event) : fallbackProject, 'call', event).then(() => setWindowCompact(true)).catch(e => setProblem(`Couldn’t start recording. ${String(e)}`));
  }
  // Start recording without a dialog (Home, the tray, ⌘⇧R), in person or on a call, as Granola's New note does.
  // The event happening now names it, and a meeting already prepared for that event records into it.
  async function quickRecord() {
    if (live.recording) { openMeeting(live.recording.meetingId, 'Notes'); return; }
    if (!live.available || !allProjects.length) { newMeeting(); return; }
    if (held(() => void trayActions.current.quickRecord())) return;
    const event = calendarOn ? await storage.calendarNow().catch(() => null) : null;
    const prepared = event && records.current.find(m => m.metadata.calendarEvent === event.id && m.metadata.status === 'idle');
    if (prepared) { openMeeting(prepared.metadata.id, 'Notes'); setCapture({ id: prepared.metadata.id, call: false }); return; }
    createMeeting(event?.title ?? 'Untitled meeting', event ? projectOf(event) : fallbackProject, true, event).catch(e => setProblem(`Couldn’t start recording. ${String(e)}`));
  }
  // Recording needs a subscription that allows it: without one the license dialog explains, and `retry` runs once it does.
  function held(retry: () => void) {
    if (licenseNow.current.mayRecord) return false;
    afterLicense.current = retry; setDialog('license');
    return true;
  }
  function licensed(status: storage.LicenseStatus) {
    setLicense(status); licenseNow.current = status; setDialog('');
    const retry = afterLicense.current;
    afterLicense.current = null;
    if (status.mayRecord) retry?.();
  }
  // The tray's next meeting opens New meeting for that event.
  function newMeetingFor(eventId?: string) {
    if (!eventId) { newMeeting(); return; }
    const known = events.find(e => e.id === eventId);
    if (known) newMeeting(known);
    else storage.calendarEvents(1).then(list => newMeeting(list.find(e => e.id === eventId) ?? null)).catch(() => newMeeting());
  }
  const trayActions = useRef({ blocked, newMeetingFor, openMeeting, go, recordCall, quickRecord });
  trayActions.current = { blocked, newMeetingFor, openMeeting, go, recordCall, quickRecord };
  useEffect(() => {
    if (!storage.desktop) return;
    let cancelled = false; const unlisten: (() => void)[] = [];
    const on = <T,>(event: string, action: (payload: T) => void) => listen<T>(event, e => { if (!trayActions.current.blocked) action(e.payload); }).then(fn => { if (cancelled) fn(); else unlisten.push(fn); });
    on<string>('quietnote://open-meeting', id => trayActions.current.openMeeting(id));
    on<string>('quietnote://open-project', p => trayActions.current.go('project', p));
    on<{ eventId?: string } | null>('quietnote://new-meeting', p => trayActions.current.newMeetingFor(p?.eventId));
    on('quietnote://open-settings', () => trayActions.current.go('settings'));
    on<string>('quietnote://record-call', app => trayActions.current.recordCall(app));
    on('quietnote://record-now', () => void trayActions.current.quickRecord());
    storage.licenseStatus().then(s => { if (!cancelled) setLicense(s); }).catch(() => { /* Rust refuses to record without one; the next start says why. */ });
    listen<storage.LicenseStatus>('quietnote://license-changed', e => setLicense(e.payload)).then(fn => { if (cancelled) fn(); else unlisten.push(fn); });
    // The call panel's "Don't notify" writes the preferences in Rust.
    listen('quietnote://preferences-changed', () => { storage.preferences().then(setPreferences).catch(() => { /* The next load reads them. */ }); }).then(fn => { if (cancelled) fn(); else unlisten.push(fn); });
    return () => { cancelled = true; unlisten.forEach(fn => fn()); };
  }, []);
  // Notes edits don't change this, so the tray menu is only rebuilt when what it shows changes.
  const traySignature = JSON.stringify([allProjects, sorted.slice(0, 3).map(m => [m.metadata.id, m.metadata.title]), contextProject]);
  useEffect(() => {
    if (loading) return;
    const timer = window.setTimeout(() => { storage.traySync(contextProject).catch(() => { /* The tray is a convenience; the window stays usable. */ }); }, 500);
    return () => clearTimeout(timer);
  }, [loading, traySignature, contextProject]);
  useEffect(() => {
    // The main actions' keys are the user's (Settings → Shortcuts); the others are fixed.
    const handler = (event: KeyboardEvent) => {
      const pressed = blocked ? null : accelerator(event);
      if (!pressed) return;
      const is = (action: Action) => pressed === bound(preferences, action);
      // ⌘K in the editor adds a link.
      if (pressed === 'CmdOrCtrl+K' && (event.target as HTMLElement | null)?.closest?.('.ProseMirror')) return;
      const project = /^CmdOrCtrl\+([1-9])$/.exec(pressed);
      if (is('search') || pressed === 'CmdOrCtrl+P' || pressed === 'CmdOrCtrl+Shift+F') { event.preventDefault(); setView('search'); searchInput.current?.select(); }
      else if (is('newMeeting')) { event.preventDefault(); newMeeting(); }
      else if (is('record')) { event.preventDefault(); void trayActions.current.quickRecord(); }
      else if (pressed === 'CmdOrCtrl+Shift+M') { event.preventDefault(); window.dispatchEvent(new CustomEvent('toggle-source-mode')); }
      else if (is('settings')) { event.preventDefault(); setView('settings'); }
      else if (is('sidebar') || pressed === 'CmdOrCtrl+Shift+Enter') { event.preventDefault(); setSidebarHidden(v => !v); }
      else if (project && allProjects[Number(project[1]) - 1]) { event.preventDefault(); go('project', allProjects[Number(project[1]) - 1]); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [blocked, newMeeting, allProjects, go, preferences]);
  const keyLabel = (action: Action) => label(bound(preferences, action));
  // Shortcut hints only appear while ⌘ is held on its own, so the sidebar stays uncluttered.
  const [showKeys, setShowKeys] = useState(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => setShowKeys(event.key === 'Meta' && !blocked);
    const up = (event: KeyboardEvent) => { if (event.key === 'Meta') setShowKeys(false); };
    const hide = () => setShowKeys(false);
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', hide);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', hide); };
  }, [blocked]);
  async function createProject(name: string) {
    await storage.createProject(name);
    setProjects(p => [...p, name]); setDialog(meetingNext ? 'meeting' : ''); setMeetingNext(false); go('project', name);
  }
  async function createMeeting(title: string, meetingProject: string, record: boolean | 'call', event: CalendarEvent | null = null) {
    const meeting = makeMeeting(title, meetingProject, event);
    await storage.createMeeting(meeting);
    upsert(meeting); remember(lastProjectKey, meetingProject); setDialog(''); openMeeting(meeting.metadata.id, 'Notes');
    const arm = () => setCapture({ id: meeting.metadata.id, call: record === 'call' });
    if (record && !held(arm)) arm();
  }
  async function addExamples() {
    setAddingExamples(true);
    try { await storage.addExamples(records.current.map(m => m.metadata.id)); await load(); go('home'); }
    catch (e) { setProblem(`Couldn’t add the example meetings. ${String(e)}`); }
    finally { setAddingExamples(false); }
  }
  /** A new title: the metadata (Rust refuses while the meeting records or transcribes), then the `# ` line of its notes file. */
  async function renameMeeting(id: string, title: string) {
    const meeting = records.current.find(m => m.metadata.id === id);
    const name = title.trim();
    if (!meeting || !name || name === meeting.metadata.title) return;
    const next = { ...meeting, metadata: { ...meeting.metadata, title: name } };
    await storage.saveMetadata(next.metadata);
    upsert(next);
    await persist(id, retitle(next.markdown, name));
  }
  /** A voice named in the transcript: Rust rewrites it and returns it as written. */
  async function renameSpeaker(id: string, from: string, to: string) {
    const transcript = await storage.renameSpeaker(id, from, to);
    const latest = records.current.find(m => m.metadata.id === id);
    if (latest) upsert({ ...latest, transcript });
  }
  /** Deleting waits for pending saves, so none recreates the meeting's file after its folder has gone; its draft goes with it. */
  async function deleteMeeting(meeting: Meeting) {
    const id = meeting.metadata.id;
    await queue.current;
    await storage.trashMeeting(meeting.metadata);
    dirty.current.delete(id); localStorage.removeItem(`quietnote.draft.${id}`);
    if (!dirty.current.size) { setSaveState('saved'); setUnsaved(''); }
    setRecords(records.current.filter(m => m.metadata.id !== id));
    setDialog(''); go('project', meeting.metadata.project);
    toast(storage.desktop ? `Moved “${meeting.metadata.title}” to the ${storage.bin}` : `Deleted “${meeting.metadata.title}”`);
  }
  /** Moving runs in the save queue: saves before it land in the old folder, saves after it in the new one. Rust moves
   * the folder even while the meeting records or is transcribed; the notes' `Project:` line follows. */
  const moveMeeting = useCallback(async function move(id: string, project: string, undo = false) {
    const meeting = records.current.find(m => m.metadata.id === id);
    if (!meeting || meeting.metadata.project === project) return;
    const from = meeting.metadata.project;
    const step = queue.current.then(async () => {
      const latest = records.current.find(m => m.metadata.id === id) ?? meeting;
      const moved = { ...latest, metadata: await storage.moveMeeting(latest.metadata, project) };
      upsert(moved);
      return moved;
    });
    queue.current = step.then(() => undefined, () => undefined);
    let moved: Meeting;
    try { moved = await step; }
    catch (e) { setProblem(`Couldn’t move “${meeting.metadata.title}” to ${project}. ${String(e)}`); return; }
    const markdown = reproject(moved.markdown, project);
    if (markdown !== moved.markdown) await persist(id, markdown);
    if (!undo) toast(`Moved “${meeting.metadata.title}” to ${project}`, { id: `moved:${id}`, duration: 5000, action: { label: 'Undo', onClick: () => void move(id, from, true) } });
  }, [persist, upsert]);
  const move = useMemo(() => ({ projects: allProjects, onMove: (id: string, project: string) => void moveMeeting(id, project) }), [allProjects, moveMeeting]);
  async function markEnded(meeting: Meeting) {
    const next: Meeting = { ...meeting, metadata: { ...meeting.metadata, status: 'ready', captureEndedAt: meeting.metadata.captureEndedAt ?? new Date().toISOString() } };
    try { await storage.saveMetadata(next.metadata); upsert(next); }
    catch (e) { setProblem(`Couldn’t update this meeting. ${String(e)}`); }
  }
  async function sent(id: string, service: storage.Service, target: string, links: IssueLink[]) {
    changePreference(`send.${service}`, target);
    const latest = records.current.find(m => m.metadata.id === id);
    if (latest && links.length) await persist(id, links.reduce((markdown, l) => linkAction(markdown, l.index, l.label, l.url), latest.markdown));
  }
  async function openArchive() {
    try { await storage.openArchive(); } catch (e) { setProblem(`Couldn’t open the archive folder. ${String(e)}`); }
  }
  const dialogs = <>
    {dialog === 'project' && <NewProjectDialog existing={allProjects} onCreate={createProject} onClose={() => { setDialog(''); setMeetingNext(false); }} />}
    {dialog === 'meeting' && <NewMeetingDialog projects={allProjects} project={contextProject} canRecord={live.available} event={meetingEvent} projectFor={projectOf} onCreate={createMeeting} onClose={() => setDialog('')} />}
    {dialog === 'license' && <LicenseDialog status={license} onActivated={licensed} onClose={() => { afterLicense.current = null; setDialog(''); }} />}
    {dialog === 'connections' && <ConnectionsDialog detectsCalls={live.detectsCalls} calendarOn={preferences.calendar === true} connections={connections} onChange={setConnections} onClose={() => setDialog('')} />}
    {dialog === 'delete' && current && <DeleteMeetingDialog title={current.metadata.title} audio={Boolean(current.metadata.audioPath)} onDelete={() => deleteMeeting(current)} onClose={() => setDialog('')} />}
    {dialog === 'send' && current && <SendDialog meeting={current} connections={connections} lastTargets={{ linear: String(preferences['send.linear'] ?? ''), github: String(preferences['send.github'] ?? '') }} onSent={(service, target, links) => sent(current.metadata.id, service, target, links)} onClose={() => setDialog('')} />}
  </>;
  if (loading && !meetings.length) return <div className="quietnote-shell centered" data-tauri-drag-region><p className="subtle" role="status">Opening your meetings…</p></div>;
  if (loadError) return <div className="quietnote-shell centered" data-tauri-drag-region><div className="load-error" role="alert">
    <h1>We couldn’t open your meeting archive.</h1>
    <p>Your files haven’t been changed. Try again, or check the archive folder.</p>
    <div className="button-row"><button className="primary" onClick={() => void load()}>Retry</button>{storage.desktop && <button className="secondary" onClick={() => void openArchive()}>Open archive location</button>}</div>
    <details className="advanced"><summary>View details</summary><p className="path">{loadError}</p></details>
    {problem && <p className="field-error">{problem}</p>}
  </div></div>;
  // The "Recording saved" / "Transcript ready" banner has the screen's Hush, outside Home (where the card has it).
  const saved = stopped ? meetings.find(m => m.metadata.id === stopped.id) : undefined;
  const bannerHush = Boolean(saved && saved.metadata.status !== 'error' && view !== 'home');
  if (replay || finishing || (!allProjects.length && !meetings.length)) return <div className="quietnote-shell centered"><Onboarding live={live} preferences={preferences} busy={addingExamples} onPreference={changePreference}
    onCreate={async name => { setFinishing(true); try { if (allProjects.includes(name)) go('project', name); else await createProject(name); } catch (e) { setFinishing(false); throw e; } }}
    onDone={() => { setFinishing(false); setReplay(false); }} onExamples={() => void addExamples().then(() => setReplay(false))} />{problem && <p className="field-error floating" role="alert">{problem}</p>}{dialogs}</div>;
  // A transcript hit opens the transcript filtered to the search, so the passage is on screen.
  const openResult = (id: string, hitTab: MeetingTab) => openMeeting(id, hitTab, hitTab === 'Transcript' ? query.trim() : '');
  const libraryMeetings = view === 'project' ? sorted.filter(m => m.metadata.project === project) : sorted;
  const itemOf = (id: string, find: (item: ActionItem) => boolean) => { const latest = records.current.find(m => m.metadata.id === id); return latest && { latest, item: actionItems(latest.markdown).find(find) }; };
  // Undo puts the item back as it was, whatever happened to it since; it's found by its text, as items above it may
  // have been removed.
  const setItem = (id: string, key: string, done: boolean) => { const found = itemOf(id, a => a.key === key); return found?.item && found.item.done !== done ? persist(id, toggleAction(found.latest.markdown, found.item.index)) : Promise.resolve(); };
  // Every tick says so in a toast with Undo; ticking the same item again replaces its toast.
  const toggleItem = (id: string, index: number) => {
    const found = itemOf(id, a => a.index === index);
    if (!found?.item) return Promise.resolve();
    const { done: was, key } = found.item;
    toast(was ? 'Reopened' : 'Marked done', { id: `action:${id}:${key}`, duration: 5000, action: { label: 'Undo', onClick: () => void setItem(id, key, was) } });
    return persist(id, toggleAction(found.latest.markdown, index));
  };
  const editItem = (id: string, index: number, text: string) => { const latest = records.current.find(m => m.metadata.id === id); return latest ? persist(id, editAction(latest.markdown, index, text)) : Promise.resolve(); };
  // Undo puts back only the removed line, where it was, leaving anything changed since.
  const removeItem = (id: string, index: number) => {
    const found = itemOf(id, a => a.index === index);
    if (!found?.item) return Promise.resolve();
    const line = actionLine(found.latest.markdown, index);
    toast(`Removed “${found.item.text}”`, { id: `removed:${id}:${found.item.key}`, duration: 5000, action: { label: 'Undo', onClick: () => { const latest = records.current.find(m => m.metadata.id === id); if (latest) void persist(id, restoreAction(latest.markdown, line, index)); } } });
    return persist(id, removeAction(found.latest.markdown, index));
  };
  // Settings shows only the pages this copy has something on; a remembered page it doesn't have opens General.
  const can = { recording: live.available, detectsCalls: live.detectsCalls === true };
  const shownSection = settingsSections(can).some(([name]) => name === settingsSection) ? settingsSection : 'General';
  // Settings → General → Your name: action items they own come first.
  const me = typeof preferences.userName === 'string' ? preferences.userName : '';
  const count = (n: number) => `${n} ${n === 1 ? 'meeting' : 'meetings'}`;
  const openItems = meetings.reduce((n, m) => n + actionItems(m.markdown).filter(a => !a.done).length, 0);
  const saveText = saveState === 'saving' ? 'Saving…' : saveState === 'unsaved' ? 'Not saved' : storage.desktop ? 'Saved' : 'Saved in this browser';
  const navItem = (active: boolean, icon: Parameters<typeof Icon>[0]['name'], label: string, onClick: () => void, extra?: ReactNode, className = '') =>
    <button className={`sidebar-item ${className} ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} title={label} onClick={onClick}><Icon name={icon} size={16} /><span className="label">{label}</span>{extra}</button>;
  return <div className={`quietnote-shell ${sidebarHidden ? 'sidebar-hidden' : ''} ${rail || narrow ? 'rail' : ''} ${narrow ? 'narrow' : ''} ${compact ? 'compact' : ''} ${storage.desktop && storage.device === 'Mac' ? 'mac-titlebar' : ''} ${showKeys ? 'show-keys' : ''}`}>
    {/* Double-clicking the divider (or Enter on it) switches between icons with labels and icons only, in place of
        Scratch's width reset; as icons only, it doesn't drag. */}
    <aside className="qn-sidebar" aria-label="Main navigation" inert={sidebarHidden || compact}
      onDoubleClickCapture={e => { if (onDivider(e)) { e.stopPropagation(); setRail(r => !r); } }}
      onKeyDownCapture={e => { if (e.key === 'Enter' && onDivider(e)) { e.preventDefault(); e.stopPropagation(); setRail(r => !r); } }}
      onPointerDownCapture={e => { if (rail && onDivider(e)) e.stopPropagation(); }}>
      <div className="sidebar-drag" data-tauri-drag-region />
      {view === 'settings' ? <SettingsNav can={can} section={shownSection} attention={diskAtRisk(disk)} onSection={setSettingsSection} onBack={() => go(beforeSettings.current.view, beforeSettings.current.project)} /> : <>
      <div className="sidebar-top">
        <button className="secondary new-meeting" title={`New meeting (${keyLabel('newMeeting')})`} onClick={() => newMeeting()}><Icon name="plus" size={16} /><span className="label">New meeting</span><kbd aria-hidden="true">{keyLabel('newMeeting')}</kbd></button>
      </div>
      <nav className="sidebar-scroll" aria-label="Meetings and projects">
        <h2 className="sidebar-label">Meetings</h2>
        {navItem(view === 'home', 'home', 'Home', () => go('home'))}
        {navItem(view === 'all', 'meeting', 'All meetings', () => go('all'))}
        {navItem(view === 'actions', 'task', 'Action items', () => go('actions'), <span className="sidebar-count">{openItems || ''}</span>)}
        {navItem(view === 'people', 'people', 'People', () => { setPerson(''); go('people'); })}
        <div className="sidebar-label-row"><h2 className="sidebar-label">Projects</h2><button className="icon-button small" aria-label="New project" title="New project" onClick={() => setDialog('project')}><Icon name="plus" size={14} /></button></div>
        {allProjects.map((p, i) => <div key={p}>{navItem(view === 'project' && project === p, 'folder', p, () => go('project', p), <><span className="initial" aria-hidden="true">{p.slice(0, 1).toUpperCase()}</span>{i < 9 && <kbd aria-hidden="true">⌘{i + 1}</kbd>}<span className="sidebar-count">{meetings.filter(m => m.metadata.project === p).length || ''}</span></>, 'project-item')}</div>)}
      </nav>
      <div className="sidebar-bottom">
        {navItem(false, 'feedback', 'Give feedback', () => void storage.giveFeedback().catch(e => setProblem(`Couldn’t open your mail app. ${String(e)}`)))}
        {navItem(dialog === 'connections', 'plug', 'Connections', () => setDialog('connections'))}
        {navItem(view === 'search', 'search', 'Search', () => setView('search'), <kbd aria-hidden="true">{keyLabel('search')}</kbd>)}
        {navItem(false, 'settings', 'Settings', () => setView('settings'), <kbd aria-hidden="true">{keyLabel('settings')}</kbd>)}
      </div></>}
      <SidebarResizeHandle />
    </aside>
    <div className="qn-workspace">
      <header className="window-bar" data-tauri-drag-region>
        <div className="window-context">{compact ? <button className="icon-button" aria-label="Open full window" title="Open full window" onClick={() => setWindowCompact(false)}><Icon name="expand" size={16} /></button> : <><button className="icon-button sidebar-toggle" aria-label={sidebarHidden ? 'Show sidebar' : 'Hide sidebar'} aria-expanded={!sidebarHidden} title={`${sidebarHidden ? 'Show' : 'Hide'} sidebar (⌘\\)`} onClick={() => setSidebarHidden(v => !v)}><Icon name="sidebar" size={16} /></button>{view === 'meeting' && current && <button className="text-button" onClick={() => go('project', current.metadata.project)}><Icon name="folder" size={15} />{current.metadata.project}</button>}</>}</div>
        {live.recording && !compact && !(view === 'meeting' && selected === live.recording.meetingId) && <RecordingBar recording={live.recording} onOpen={() => openMeeting(live.recording!.meetingId, 'Notes')} onStop={() => void captureAction(storage.captureStop, 'Couldn’t stop recording.')} onResume={() => void storage.captureResume().catch((e: storage.CaptureFailure) => setProblem(`Couldn’t resume recording. ${e.message}`))} onKeep={() => void storage.captureKeep().catch(e => setProblem(`Couldn’t keep recording. ${String(e)}`))} />}
        <div className={`save-status ${saveState}`} role="status" aria-live="polite"><i aria-hidden="true" />{saveText}{!storage.desktop && <span className="save-where">Browser preview</span>}</div>
      </header>
      {unsaved && <div className="banner warning" role="alert">
        <div><strong>{unsaved === 'recovered' ? 'Recovered unsaved changes from your last session.' : storage.desktop ? 'Your latest changes haven’t been saved to disk.' : 'Your latest changes haven’t been saved in this browser.'}</strong><span>{unsaved === 'recovered' ? 'They’re shown in your notes but not yet written to the archive.' : 'A draft copy is kept. Nothing is lost while this window stays open.'}</span>{unsaved === 'failed' && saveDetail && <details><summary>Details</summary>{saveDetail}</details>}</div>
        <div className="banner-actions"><button className="primary" onClick={() => void retry()}>{unsaved === 'recovered' ? 'Save now' : 'Retry'}</button>{confirmDiscard ? <button className="secondary danger" onClick={() => void discard()}>Discard changes</button> : <button className="secondary" onClick={() => setConfirmDiscard(true)}>{unsaved === 'recovered' ? 'Discard' : 'Reload saved version'}</button>}</div>
      </div>}
      {(() => {
        const recovered = sorted.filter(m => m.metadata.interrupted && !recoverySeen.includes(m.metadata.id));
        if (!recovered.length) return null;
        const first = recovered[0].metadata;
        return <div className="banner" role="status"><div><strong>Recovered recording</strong><span>{recovered.length === 1 ? `We found an interrupted recording from “${first.title}”.` : `We found ${recovered.length} interrupted recordings, the latest from “${first.title}”.`} QuietNote closed before it was stopped; the audio up to that point was saved.</span></div>
          <div className="banner-actions"><button className="secondary" onClick={() => { setRecoverySeen(seen => [...seen, first.id]); openMeeting(first.id); }}>Open meeting</button><button className="text-button" onClick={() => setRecoverySeen(seen => [...seen, ...recovered.map(m => m.metadata.id)])}>Dismiss</button></div></div>;
      })()}
      {(() => {
        const meeting = saved;
        if (!meeting || meeting.metadata.status === 'error') return null;
        const done = meeting.metadata.status === 'ready';
        return <div className="banner" role="status">{bannerHush && <Hush mood={done ? 'done' : 'transcribing'} size={44} />}<div><strong>{done ? 'Transcript ready' : 'Recording saved'}</strong><span>{done ? `“${meeting.metadata.title}” is ready to review.` : `Transcribing “${meeting.metadata.title}” on this ${storage.device}. You can keep working.`}</span></div>
          <div className="banner-actions"><button className="secondary" onClick={() => openMeeting(meeting.metadata.id, done ? 'Transcript' : undefined)}>Open meeting</button><button className="text-button" onClick={() => setStopped(null)}>Dismiss</button></div></div>;
      })()}
      {external && !unsaved && <div className="banner" role="status"><div><strong>Files changed outside QuietNote.</strong><span>Refresh to load the latest version from disk.</span></div><div className="banner-actions"><button className="secondary" onClick={() => void reload()}>Refresh</button></div></div>}
      {problem && <div className="banner warning" role="alert"><div><strong>{problem}</strong></div><div className="banner-actions"><button className="text-button" onClick={() => setProblem('')}>Dismiss</button></div></div>}
      <main className="qn-main" ref={main}><HushYield.Provider value={bannerHush}>
        {view === 'settings' ? <Settings recording={live.available} detectsCalls={live.detectsCalls} liveTranscript={live.liveTranscript} disk={disk} summaryKey={summaryKey} onSummaryKey={setSummaryKey} section={shownSection} values={preferences} onChange={changePreference} root={root} hasAllExamples={demoMeetings.every(d => meetings.some(m => m.metadata.id === d.metadata.id))} onOpenArchive={() => void openArchive()} onReload={() => void reload()} onWorkspace={() => { window.location.href = '?workspace=markdown'; }} onExamples={() => void addExamples()} />
        : view === 'meeting' && current ? <MeetingDetail key={`${current.metadata.id}-${reloadKey}-${find}`} meeting={current} onRename={title => renameMeeting(current.metadata.id, title)} onSpeaker={(from, to) => renameSpeaker(current.metadata.id, from, to)} previous={previous} onPrevious={index => toggleItem(previous!.metadata.id, index)} onToggle={index => toggleItem(current.metadata.id, index)} onEdit={(index, text) => editItem(current.metadata.id, index, text)} onRemove={index => removeItem(current.metadata.id, index)} me={me} onOpenPrevious={() => openMeeting(previous!.metadata.id)} find={find} example={isExample(current.metadata.id)} connections={connections} onSend={() => setDialog('send')} tab={tab} onTab={setTab} live={live} cleanDefault={preferences.cleanTranscript !== false} deleteAudio={preferences.deleteAudio === true} summarizer={summarizer} template={typeof preferences.noteTemplate === 'string' ? preferences.noteTemplate : ''} onDismissRecovered={() => void dismissRecovered(current)} armed={capture?.id === current.metadata.id && (capture.call ? 'call' : true)} onUpdated={upsert} onStartCapture={() => { const arm = () => { setCapture({ id: current.metadata.id, call: false }); setTab('Notes'); }; if (!held(arm)) arm(); }} onCloseCapture={() => setCapture(null)} onRetry={() => void captureAction(() => storage.transcribe(current.metadata.id), 'Couldn’t start transcribing.')} onExportAudio={() => void exportAudio(current)} onMarkEnded={() => void markEnded(current)} onDelete={() => setDialog('delete')} onDraft={notes => backupNotes(current.metadata.id, notes)} onMarkdown={markdown => persist(current.metadata.id, markdown)} onNotes={notes => {
          const latest = records.current.find(m => m.metadata.id === current.metadata.id);
          // The editor can save once more as it closes, after its meeting was deleted.
          if (!latest) return Promise.resolve();
          return persist(current.metadata.id, replaceSection(latest.markdown, 'Notes', notes));
        }} />
        : view === 'search' ? <div className="page search-page">
          <label className="search-field"><Icon name="search" size={18} /><input ref={searchInput} type="search" aria-label="Search meetings" placeholder="Search meetings…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && results[0]) openResult(results[0].meeting.metadata.id, results[0].tab); }} /></label>
          {!query.trim() ? <p className="subtle">Search titles, notes, action items and transcripts.</p>
          : results.length ? <><p className="result-count" role="status">{results.length === 1 ? '1 meeting' : `${results.length} meetings`}</p><ul className="results">{results.map(({ meeting, tab: hitTab, snippet }) => <li key={meeting.metadata.id}><button className="result" onClick={() => openResult(meeting.metadata.id, hitTab)}>
            <strong><Highlight text={meeting.metadata.title} terms={searchTerms(query)} /></strong>
            <span className="result-meta">{shortDate(meeting.metadata.date)} · {meeting.metadata.project}{hitTab !== 'Enhanced' && ` · in ${hitTab === 'Notes' ? 'your notes' : 'the transcript'}`}</span>
            {snippet && <span className="snippet"><Highlight text={snippet} terms={searchTerms(query)} /></span>}
          </button></li>)}</ul></>
          : <div className="empty-inline" role="status"><Hush mood="resting" size={72} /><h2>No meetings found for ‘{query.trim()}’.</h2><p>Try another term.</p></div>}
        </div>
        : view === 'people' ? <People meetings={meetings} selected={person} calendar={calendarOn} move={move} onSelect={setPerson} onOpen={openMeeting} onToggle={toggleItem} onSettings={() => { setSettingsSection('Privacy'); go('settings'); }} />
        : view === 'actions' ? <ActionItems meetings={sorted} me={me} onOpen={openMeeting} onToggle={toggleItem} />
        : view === 'home' ? <Home meetings={sorted} me={me} live={live} events={events} move={move} onPrepare={event => void (allProjects.length ? createMeeting(event.title, projectOf(event), false, event) : Promise.resolve(newMeeting(event))).catch(e => setProblem(`Couldn’t create the meeting. ${String(e)}`))} onOpen={openMeeting} onNewMeeting={() => newMeeting()} onRecord={() => void quickRecord()} onName={() => { setSettingsSection('General'); setView('settings'); }} onSearch={text => { setQuery(text); setView('search'); }} onToggle={toggleItem} onAll={() => go('all')} onAllActions={() => go('actions')} />
        : <div className="page library-page">
          <header className="page-header"><div><h1>{view === 'project' ? project : 'All meetings'}</h1>{libraryMeetings.length > 0 && <p className="subtle">{count(libraryMeetings.length)}</p>}</div></header>
          {libraryMeetings.length ? <MeetingList meetings={libraryMeetings} showProject={view !== 'project'} onOpen={openMeeting} move={move} />
          : <div className="empty-state"><Hush mood="resting" size={88} fallback={<Folder />} /><h2>{view === 'project' ? `No meetings in ${project} yet.` : 'No meetings yet.'}</h2><p>{live.available ? 'Record a meeting, or create one to take notes.' : 'Create a meeting to take notes.'}</p><button className="secondary" onClick={() => view === 'project' ? setDialog('meeting') : newMeeting()}><Icon name="plus" size={15} />New meeting</button></div>}
        </div>}
      </HushYield.Provider></main>
    </div>
    {dialogs}
  </div>;
}
/** An unexpected error shows what happened instead of a blank window. Drafts are kept in webview storage, so reloading loses nothing typed. */
class Crashed extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('QuietNote hit an error.', error); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <div className="quietnote-shell centered" data-tauri-drag-region><div className="load-error" role="alert">
      <h1>Something went wrong in QuietNote.</h1>
      <p>Your meetings and any recording in progress are unaffected. Reload to continue; unsaved notes are restored from your draft.</p>
      <div className="button-row"><button className="primary" onClick={() => location.reload()}>Reload</button></div>
      <details className="advanced"><summary>View details</summary><p className="path">{error.stack ?? String(error)}</p></details>
    </div></div>;
  }
}
// The editor's toasts (Copied as Markdown, …) as QuietNote's dark pill instead of Scratch's card.
const Toasts = () => <Toaster position="bottom-center" offset={24} toastOptions={{ unstyled: true, classNames: { toast: 'qn-toast' } }} />;

export default function QuietNoteApp() { return <ThemeProvider><TooltipProvider><Crashed><Shell /></Crashed><Toasts /></TooltipProvider></ThemeProvider>; }
