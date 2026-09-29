import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { ThemeProvider } from '../context/ThemeContext';
import { TooltipProvider, Toaster } from '../components/ui';
import { SidebarResizeHandle } from '../components/layout/SidebarResizeHandle';
import { Folder, Icon, Logo } from './Icon';
import { NewMeetingDialog, NewProjectDialog } from './Dialogs';
import { ConnectionsDialog, SendDialog, type IssueLink } from './Connectors';
import { Settings, type SettingsSection } from './Settings';
import { MeetingDetail } from './MeetingDetail';
import { Home, MeetingList } from './Library';
import { clock, linkAction, makeMeeting, replaceSection, searchMeeting, searchTerms, section, shortDate, toggleAction, type Meeting, type MeetingTab } from './model';
import { demoMeetings, isExample } from './seeds';
import * as storage from './storage';
import './quietnote.css';

type View = 'home' | 'all' | 'project' | 'meeting' | 'search' | 'settings';
type Place = { view: View; project: string; selected: string; tab: MeetingTab; section: SettingsSection };
const placeKey = 'quietnote.place.v1';
const lastProjectKey = 'quietnote.lastProject';
function remembered<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; } }
function remember(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Per-viewer convenience only. */ } }
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  // The whole phrase is tried first so "phase two" highlights as one match.
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(${[terms.join(' '), ...terms].map(escape).join('|')})`, 'gi');
  return <>{text.split(pattern).map((part, i) => i % 2 ? <mark key={i}>{part}</mark> : part)}</>;
}
/** Shown in every view while recording, so "is QuietNote recording?" always has an answer. The recording meeting has its own recorder strip instead. */
function RecordingBar({ recording, onOpen, onStop }: { recording: NonNullable<storage.CaptureState['recording']>; onOpen: () => void; onStop: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  const elapsed = clock((now - Date.parse(recording.startedAt)) / 1000);
  return <div className="recording-bar" role="group" aria-label={`Recording ${recording.title}, ${elapsed}`}>
    <i className="live-dot" aria-hidden="true" /><span className="recording-label">Recording</span>
    <button className="text-button recording-title" title="Open meeting" onClick={onOpen}>{recording.title}</button>
    <span className="recording-time" aria-hidden="true">{elapsed}</span>
    {recording.problem && <span className="recording-problem" role="img" aria-label={recording.problem} title={recording.problem}><Icon name="info" size={14} /></span>}
    <button className="text-button" onClick={onStop}>Stop recording</button>
  </div>;
}
function Welcome({ recording, onCreate, onExamples, busy }: { recording: boolean; onCreate: () => void; onExamples: () => void; busy: boolean }) {
  return <div className="welcome" data-tauri-drag-region>
    <Folder />
    <h1>Keep the useful part of every meeting.</h1>
    <p>{recording ? `Records and transcribes your meetings on this ${storage.device}. No bot joins the call, and nothing records until you press Start.` : 'Notes, decisions and action items for your meetings, organized by project and kept on your device.'}</p>
    <button className="primary large" onClick={onCreate}>Create your first project</button>
    <button className="text-button" disabled={busy} onClick={onExamples}>{busy ? 'Adding examples…' : 'Explore example meetings'}</button>
    {!storage.desktop && <p className="subtle">Browser preview · meetings are saved in this browser only.</p>}
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
  const [tab, setTab] = useState<MeetingTab>(initial.tab ?? 'Summary');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(initial.section ?? 'Privacy');
  const [query, setQuery] = useState('');
  const [indexedIds, setIndexedIds] = useState<string[]>([]);
  const [dialog, setDialog] = useState<'' | 'project' | 'meeting' | 'connections' | 'send'>('');
  // The meeting whose recording was asked for: its recorder strip starts it (or explains first).
  const [capture, setCapture] = useState<string | null>(null);
  const [live, setLive] = useState<storage.CaptureState>(storage.noCapture);
  // New meeting asked for before any project existed: it opens once the project is created.
  const [meetingNext, setMeetingNext] = useState(false);
  const [stopped, setStopped] = useState<{ id: string; title: string } | null>(null);
  const [recoverySeen, setRecoverySeen] = useState<string[]>([]);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [addingExamples, setAddingExamples] = useState(false);
  const [preferences, setPreferences] = useState<storage.PrivacyPreferences>({});
  const [connections, setConnections] = useState<storage.Connections>({});
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
    } catch (e) { setLoadError(String(e)); }
    finally { setLoading(false); }
  }, [setRecords]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { remember(placeKey, { view, project, selected, tab, section: settingsSection }); }, [view, project, selected, tab, settingsSection]);
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
    else if (previous) { setStopped({ id: previous.meetingId, title: previous.title }); setCapture(c => c === previous.meetingId ? null : c); }
  }, [live.recording]);
  const updateMetadata = useCallback((metadata: Meeting['metadata']) => {
    const existing = records.current.find(m => m.metadata.id === metadata.id);
    if (existing) upsert({ ...existing, metadata });
  }, [upsert]);
  async function captureAction(action: () => Promise<Meeting['metadata']>, failure: string) {
    try { updateMetadata(await action()); } catch (e) { setProblem(`${failure} ${String(e).replace(/^Error: /, '')}`); }
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
        await storage.saveMarkdown(meeting.metadata, markdown);
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
  function changePreference(key: string, value: boolean | string) {
    const next = { ...preferences, [key]: value }; setPreferences(next);
    queue.current = queue.current.then(async () => {
      try { await storage.preferences(next); } catch (e) { setProblem(`Couldn’t save your privacy preferences. ${String(e)}`); return; }
      if (key === 'cleanTranscript') await storage.renderTranscripts(value === true).catch(e => setProblem(`Couldn’t update your transcripts. ${String(e)}`));
    });
  }
  const go = useCallback((next: View, nextProject = '') => { setView(next); setProject(nextProject); }, []);
  const [find, setFind] = useState('');
  const openMeeting = useCallback((id: string, nextTab: MeetingTab = 'Summary', nextFind = '') => { setSelected(id); setTab(nextTab); setFind(nextFind); setView('meeting'); }, []);
  useEffect(() => { if (view === 'meeting' && stopped?.id === selected) setStopped(null); }, [view, selected, stopped]);
  // A start that's still waiting (first-run explanation, a permission problem) is dropped on leaving its meeting.
  useEffect(() => { setCapture(c => c && (view !== 'meeting' || selected !== c) ? null : c); }, [view, selected]);
  const sorted = useMemo(() => [...meetings].sort((a, b) => b.metadata.date.localeCompare(a.metadata.date)), [meetings]);
  const allProjects = useMemo(() => [...new Set([...projects, ...meetings.map(m => m.metadata.project)])].sort((a, b) => a.localeCompare(b)), [projects, meetings]);
  const current = meetings.find(m => m.metadata.id === selected);
  const contextProject = view === 'project' ? project : view === 'meeting' && current ? current.metadata.project : remembered(lastProjectKey, '');
  const newMeeting = useCallback(() => { setMeetingNext(!allProjects.length); setDialog(allProjects.length ? 'meeting' : 'project'); }, [allProjects.length]);
  const results = useMemo(() => {
    if (!query.trim()) return [];
    return sorted.flatMap(meeting => {
      const hit = searchMeeting(meeting, query) ?? (indexedIds.includes(meeting.metadata.id) ? { tab: 'Summary' as MeetingTab, snippet: section(meeting.markdown, 'Summary').slice(0, 160) } : null);
      return hit ? [{ meeting, ...hit }] : [];
    });
  }, [sorted, query, indexedIds]);
  // A stale remembered place (deleted meeting or project) falls back to Home.
  useEffect(() => {
    if (loading) return;
    if ((view === 'meeting' && !current) || (view === 'project' && !allProjects.includes(project))) go('home');
  }, [loading, view, current, project, allProjects, go]);
  const blocked = Boolean(dialog);
  // Tray actions arrive after Rust has shown the window. An open dialog is never replaced.
  const trayActions = useRef({ blocked, newMeeting, openMeeting, go });
  trayActions.current = { blocked, newMeeting, openMeeting, go };
  useEffect(() => {
    if (!storage.desktop) return;
    let cancelled = false; const unlisten: (() => void)[] = [];
    const on = <T,>(event: string, action: (payload: T) => void) => listen<T>(event, e => { if (!trayActions.current.blocked) action(e.payload); }).then(fn => { if (cancelled) fn(); else unlisten.push(fn); });
    on<string>('quietnote://open-meeting', id => trayActions.current.openMeeting(id));
    on<string>('quietnote://open-project', p => trayActions.current.go('project', p));
    on('quietnote://new-meeting', () => trayActions.current.newMeeting());
    on('quietnote://open-settings', () => trayActions.current.go('settings'));
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
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || blocked) return;
      const key = event.key.toLowerCase();
      if (key === 'k' && (event.target as HTMLElement | null)?.closest?.('.ProseMirror')) return;
      if (key === 'k' || key === 'p' || (event.shiftKey && key === 'f')) { event.preventDefault(); setView('search'); searchInput.current?.select(); }
      else if (key === 'n') { event.preventDefault(); newMeeting(); }
      else if (event.shiftKey && key === 'm') { event.preventDefault(); window.dispatchEvent(new CustomEvent('toggle-source-mode')); }
      else if (key === ',') { event.preventDefault(); setView('settings'); }
      else if (key === '\\' || (event.shiftKey && key === 'enter')) { event.preventDefault(); setSidebarHidden(v => !v); }
      else if (/^[1-9]$/.test(key) && !event.altKey && !event.shiftKey && allProjects[Number(key) - 1]) { event.preventDefault(); go('project', allProjects[Number(key) - 1]); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [blocked, newMeeting, allProjects, go]);
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
  async function createMeeting(title: string, meetingProject: string, record: boolean) {
    const meeting = makeMeeting(title, meetingProject);
    await storage.createMeeting(meeting);
    upsert(meeting); remember(lastProjectKey, meetingProject); setDialog(''); openMeeting(meeting.metadata.id, record ? 'Notes' : 'Summary');
    if (record) setCapture(meeting.metadata.id);
  }
  async function addExamples() {
    setAddingExamples(true);
    try { await storage.addExamples(records.current.map(m => m.metadata.id)); await load(); go('home'); }
    catch (e) { setProblem(`Couldn’t add the example meetings. ${String(e)}`); }
    finally { setAddingExamples(false); }
  }
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
    {dialog === 'meeting' && <NewMeetingDialog projects={allProjects} project={contextProject} canRecord={live.available} onCreate={createMeeting} onClose={() => setDialog('')} />}
    {dialog === 'connections' && <ConnectionsDialog connections={connections} onChange={setConnections} onClose={() => setDialog('')} />}
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
  if (!allProjects.length && !meetings.length) return <div className="quietnote-shell centered"><Welcome recording={live.available} busy={addingExamples} onCreate={() => setDialog('project')} onExamples={() => void addExamples()} />{problem && <p className="field-error floating" role="alert">{problem}</p>}{dialogs}</div>;
  // A transcript hit opens the transcript filtered to the search, so the passage is on screen.
  const openResult = (id: string, hitTab: MeetingTab) => openMeeting(id, hitTab, hitTab === 'Transcript' ? query.trim() : '');
  const libraryMeetings = view === 'project' ? sorted.filter(m => m.metadata.project === project) : sorted;
  const toggleItem = (id: string, index: number) => { const latest = records.current.find(m => m.metadata.id === id); return latest ? persist(id, toggleAction(latest.markdown, index)) : Promise.resolve(); };
  const count = (n: number) => `${n} ${n === 1 ? 'meeting' : 'meetings'}`;
  const saveText = saveState === 'saving' ? 'Saving…' : saveState === 'unsaved' ? 'Not saved' : storage.desktop ? 'Saved' : 'Saved in this browser';
  const navItem = (active: boolean, icon: Parameters<typeof Icon>[0]['name'], label: string, onClick: () => void, extra?: ReactNode, className = '') =>
    <button className={`sidebar-item ${className} ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} title={label} onClick={onClick}><Icon name={icon} size={16} /><span className="label">{label}</span>{extra}</button>;
  return <div className={`quietnote-shell ${sidebarHidden ? 'sidebar-hidden' : ''} ${storage.desktop && storage.device === 'Mac' ? 'mac-titlebar' : ''} ${showKeys ? 'show-keys' : ''}`}>
    <aside className="qn-sidebar" aria-label="Main navigation" inert={sidebarHidden}>
      <div className="sidebar-drag" data-tauri-drag-region />
      <div className="sidebar-top">
        <button className="brand" aria-label="QuietNote" onClick={() => go('home')}><Logo /><span className="label">QuietNote</span></button>
        <button className="primary new-meeting" title="New meeting (⌘N)" onClick={() => newMeeting()}><Icon name="plus" size={16} /><span className="label">New meeting</span><kbd aria-hidden="true">⌘N</kbd></button>
      </div>
      <nav className="sidebar-scroll" aria-label="Meetings and projects">
        <h2 className="sidebar-label">Meetings</h2>
        {navItem(view === 'home', 'home', 'Home', () => go('home'))}
        {navItem(view === 'all', 'meeting', 'All meetings', () => go('all'))}
        <div className="sidebar-label-row"><h2 className="sidebar-label">Projects</h2><button className="icon-button small" aria-label="New project" title="New project" onClick={() => setDialog('project')}><Icon name="plus" size={14} /></button></div>
        {allProjects.map((p, i) => <div key={p}>{navItem(view === 'project' && project === p, 'folder', p, () => go('project', p), <><span className="initial" aria-hidden="true">{p.slice(0, 1).toUpperCase()}</span>{i < 9 && <kbd aria-hidden="true">⌘{i + 1}</kbd>}<span className="sidebar-count">{meetings.filter(m => m.metadata.project === p).length || ''}</span></>, 'project-item')}</div>)}
      </nav>
      <div className="sidebar-bottom">
        {navItem(dialog === 'connections', 'plug', 'Connections', () => setDialog('connections'))}
        {navItem(view === 'search', 'search', 'Search', () => setView('search'), <kbd aria-hidden="true">⌘K</kbd>)}
        {navItem(view === 'settings', 'settings', 'Settings', () => setView('settings'), <kbd aria-hidden="true">⌘,</kbd>)}
      </div>
      <SidebarResizeHandle />
    </aside>
    <div className="qn-workspace">
      <header className="window-bar" data-tauri-drag-region>
        <div className="window-context"><button className="icon-button sidebar-toggle" aria-label={sidebarHidden ? 'Show sidebar' : 'Hide sidebar'} aria-expanded={!sidebarHidden} title={`${sidebarHidden ? 'Show' : 'Hide'} sidebar (⌘\\)`} onClick={() => setSidebarHidden(v => !v)}><Icon name="sidebar" size={16} /></button>{view === 'meeting' && current && <button className="text-button" onClick={() => go('project', current.metadata.project)}><Icon name="folder" size={15} />{current.metadata.project}</button>}</div>
        {live.recording && !(view === 'meeting' && selected === live.recording.meetingId) && <RecordingBar recording={live.recording} onOpen={() => openMeeting(live.recording!.meetingId, 'Notes')} onStop={() => void captureAction(storage.captureStop, 'Couldn’t stop recording.')} />}
        <div className={`save-status ${saveState}`} role="status" aria-live="polite"><i aria-hidden="true" />{saveText}{!storage.desktop && <span className="badge">Browser preview</span>}</div>
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
        const meeting = stopped && meetings.find(m => m.metadata.id === stopped.id);
        if (!meeting || meeting.metadata.status === 'error') return null;
        const done = meeting.metadata.status === 'ready';
        return <div className="banner" role="status"><div><strong>{done ? 'Transcript ready' : 'Recording saved'}</strong><span>{done ? `“${meeting.metadata.title}” is ready to review.` : `Transcribing “${meeting.metadata.title}” on this ${storage.device}. You can keep working.`}</span></div>
          <div className="banner-actions"><button className="secondary" onClick={() => openMeeting(meeting.metadata.id, done ? 'Transcript' : 'Summary')}>Open meeting</button><button className="text-button" onClick={() => setStopped(null)}>Dismiss</button></div></div>;
      })()}
      {external && !unsaved && <div className="banner" role="status"><div><strong>Files changed outside QuietNote.</strong><span>Refresh to load the latest version from disk.</span></div><div className="banner-actions"><button className="secondary" onClick={() => void reload()}>Refresh</button></div></div>}
      {problem && <div className="banner warning" role="alert"><div><strong>{problem}</strong></div><div className="banner-actions"><button className="text-button" onClick={() => setProblem('')}>Dismiss</button></div></div>}
      <main className="qn-main" ref={main}>
        {view === 'settings' ? <Settings recording={live.available} connections={connections} section={settingsSection} onSection={setSettingsSection} values={preferences} onChange={changePreference} root={root} hasAllExamples={demoMeetings.every(d => meetings.some(m => m.metadata.id === d.metadata.id))} onOpenArchive={() => void openArchive()} onReload={() => void reload()} onWorkspace={() => { window.location.href = '?workspace=markdown'; }} onExamples={() => void addExamples()} />
        : view === 'meeting' && current ? <MeetingDetail key={`${current.metadata.id}-${reloadKey}-${find}`} meeting={current} find={find} example={isExample(current.metadata.id)} connections={connections} onSend={() => setDialog('send')} tab={tab} onTab={setTab} live={live} cleanDefault={preferences.cleanTranscript !== false} onDismissRecovered={() => void dismissRecovered(current)} armed={capture === current.metadata.id} onUpdated={upsert} onStartCapture={() => { setCapture(current.metadata.id); setTab('Notes'); }} onCloseCapture={() => setCapture(null)} onRetry={() => void captureAction(() => storage.transcribe(current.metadata.id), 'Couldn’t start transcribing.')} onMarkEnded={() => void markEnded(current)} onDraft={notes => backupNotes(current.metadata.id, notes)} onMarkdown={markdown => persist(current.metadata.id, markdown)} onNotes={notes => {
          const latest = records.current.find(m => m.metadata.id === current.metadata.id)!;
          return persist(current.metadata.id, replaceSection(latest.markdown, 'Notes', notes));
        }} />
        : view === 'search' ? <div className="page search-page">
          <label className="search-field"><Icon name="search" size={18} /><input ref={searchInput} type="search" aria-label="Search meetings" placeholder="Search meetings…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && results[0]) openResult(results[0].meeting.metadata.id, results[0].tab); }} /></label>
          {!query.trim() ? <p className="subtle">Search titles, summaries, decisions, action items, notes and transcripts.</p>
          : results.length ? <><p className="result-count" role="status">{results.length === 1 ? '1 meeting' : `${results.length} meetings`}</p><ul className="results">{results.map(({ meeting, tab: hitTab, snippet }) => <li key={meeting.metadata.id}><button className="result" onClick={() => openResult(meeting.metadata.id, hitTab)}>
            <strong><Highlight text={meeting.metadata.title} terms={searchTerms(query)} /></strong>
            <span className="result-meta">{shortDate(meeting.metadata.date)} · {meeting.metadata.project}{hitTab !== 'Summary' && ` · in ${hitTab}`}</span>
            {snippet && <span className="snippet"><Highlight text={snippet} terms={searchTerms(query)} /></span>}
          </button></li>)}</ul></>
          : <div className="empty-inline" role="status"><h2>No meetings found for ‘{query.trim()}’.</h2><p>Try another term.</p></div>}
        </div>
        : view === 'home' ? <Home meetings={sorted} live={live} onOpen={openMeeting} onNewMeeting={newMeeting} onSearch={text => { setQuery(text); setView('search'); }} onToggle={toggleItem} onAll={() => go('all')} />
        : <div className="page library-page">
          <header className="page-header"><div><h1>{view === 'project' ? project : 'All meetings'}</h1>{libraryMeetings.length > 0 && <p className="subtle">{count(libraryMeetings.length)}</p>}</div></header>
          {libraryMeetings.length ? <MeetingList meetings={libraryMeetings} showProject={view !== 'project'} onOpen={openMeeting} />
          : <div className="empty-state"><Folder /><h2>{view === 'project' ? `No meetings in ${project} yet.` : 'No meetings yet.'}</h2><p>{live.available ? 'Record a meeting, or create one to take notes.' : 'Create a meeting to take notes.'}</p><button className="secondary" onClick={() => view === 'project' ? setDialog('meeting') : newMeeting()}><Icon name="plus" size={15} />New meeting</button></div>}
        </div>}
      </main>
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
export default function QuietNoteApp() { return <ThemeProvider><TooltipProvider><Crashed><Shell /></Crashed><Toaster /></TooltipProvider></ThemeProvider>; }
