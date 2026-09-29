import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { ThemeProvider } from '../context/ThemeContext';
import { TooltipProvider, Toaster } from '../components/ui';
import { SidebarResizeHandle } from '../components/layout/SidebarResizeHandle';
import { Icon, Logo } from './Icon';
import { Capture } from './Capture';
import { NewMeetingDialog, NewProjectDialog } from './Dialogs';
import { Settings, type SettingsSection } from './Settings';
import { MeetingDetail } from './MeetingDetail';
import { dayGroup, durationLabel, makeMeeting, replaceSection, searchMeeting, searchTerms, section, shortDate, statusLabel, type Meeting, type MeetingTab } from './model';
import { demoMeetings, isExample } from './seeds';
import * as storage from './storage';
import './quietnote.css';

type View = 'recent' | 'all' | 'project' | 'meeting' | 'search' | 'settings';
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
const MeetingRow = memo(function MeetingRow({ meeting, showProject, onOpen }: { meeting: Meeting; showProject: boolean; onOpen: (id: string) => void }) {
  const { id, title, project, date, duration, status } = meeting.metadata;
  const label = statusLabel(status);
  return <button className={`meeting-row ${showProject ? '' : 'no-project'}`} onClick={() => onOpen(id)}>
    <span className="row-title"><strong>{title}</strong>{isExample(id) && <span className="badge example">Example</span>}</span>
    {showProject && <span className="row-project">{project}</span>}
    <span className="row-date">{shortDate(date)}</span>
    <span className="row-duration">{durationLabel(duration)}</span>
    <span className="row-status">{label && <span className={`status ${status}`}><i aria-hidden="true" />{label}</span>}</span>
  </button>;
});
function MeetingList({ meetings, showProject, onOpen }: { meetings: Meeting[]; showProject: boolean; onOpen: (id: string) => void }) {
  const groups: [string, Meeting[]][] = [];
  for (const m of meetings) {
    const label = dayGroup(m.metadata.date);
    if (groups[groups.length - 1]?.[0] === label) groups[groups.length - 1][1].push(m); else groups.push([label, [m]]);
  }
  return <div className="meeting-list">{groups.map(([label, items]) => <section key={label} aria-label={label}><h2 className="group-label">{label}</h2>{items.map(m => <MeetingRow key={m.metadata.id} meeting={m} showProject={showProject} onOpen={onOpen} />)}</section>)}</div>;
}
function Welcome({ onCreate, onExamples, busy }: { onCreate: () => void; onExamples: () => void; busy: boolean }) {
  return <div className="welcome" data-tauri-drag-region>
    <Logo size={44} />
    <h1>Keep the useful part of every meeting.</h1>
    <p>QuietNote keeps your meeting workspace local and organized around projects.</p>
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
  const [view, setView] = useState<View>(initial.view ?? 'recent');
  const [project, setProject] = useState(initial.project ?? '');
  const [selected, setSelected] = useState(initial.selected ?? '');
  const [tab, setTab] = useState<MeetingTab>(initial.tab ?? 'Summary');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(initial.section ?? 'Privacy');
  const [query, setQuery] = useState('');
  const [indexedIds, setIndexedIds] = useState<string[]>([]);
  const [dialog, setDialog] = useState<'' | 'project' | 'meeting'>('');
  const [capture, setCapture] = useState<{ id: string; auto: boolean } | null>(null);
  const [review, setReview] = useState(false);
  const [addingExamples, setAddingExamples] = useState(false);
  const [preferences, setPreferences] = useState<storage.PrivacyPreferences>({});
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
        if (m.metadata.status === 'recording' || m.metadata.status === 'processing') return { ...meeting, metadata: { ...meeting.metadata, status: 'error' as const } };
        return meeting;
      });
      setRoot(archive.root); setProjects(archive.projects); setRecords(restored);
      if (recovered) { setUnsaved('recovered'); setSaveState('unsaved'); }
      setPreferences(await storage.preferences());
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
  const captureOpen = useRef(capture); captureOpen.current = capture;
  useEffect(() => {
    if (!storage.desktop) return;
    let cancelled = false; let unlisten: (() => void) | undefined; let allowClose = false;
    const appWindow = getCurrentWindow();
    appWindow.onCloseRequested(async event => {
      if (allowClose || captureOpen.current) return;
      event.preventDefault();
      await Promise.all([...dirty.current].map(([id, markdown]) => persist(id, markdown)));
      await queue.current;
      if (!dirty.current.size) { allowClose = true; await appWindow.close(); }
    }).then(fn => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
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
    queue.current = queue.current.then(async () => { try { await storage.preferences(next); } catch (e) { setProblem(`Couldn’t save your privacy preferences. ${String(e)}`); } });
  }
  const go = useCallback((next: View, nextProject = '') => { setView(next); setProject(nextProject); setReview(false); }, []);
  const openMeeting = useCallback((id: string, nextTab: MeetingTab = 'Summary') => { setSelected(id); setTab(nextTab); setView('meeting'); }, []);
  const sorted = useMemo(() => [...meetings].sort((a, b) => b.metadata.date.localeCompare(a.metadata.date)), [meetings]);
  const allProjects = useMemo(() => [...new Set([...projects, ...meetings.map(m => m.metadata.project)])].sort((a, b) => a.localeCompare(b)), [projects, meetings]);
  const current = meetings.find(m => m.metadata.id === selected);
  const contextProject = view === 'project' ? project : view === 'meeting' && current ? current.metadata.project : remembered(lastProjectKey, '');
  const newMeeting = useCallback(() => setDialog(allProjects.length ? 'meeting' : 'project'), [allProjects.length]);
  const results = useMemo(() => {
    if (!query.trim()) return [];
    return sorted.flatMap(meeting => {
      const hit = searchMeeting(meeting, query) ?? (indexedIds.includes(meeting.metadata.id) ? { tab: 'Summary' as MeetingTab, snippet: section(meeting.markdown, 'Summary').slice(0, 160) } : null);
      return hit ? [{ meeting, ...hit }] : [];
    });
  }, [sorted, query, indexedIds]);
  // A stale remembered place (deleted meeting or project) falls back to Recent.
  useEffect(() => {
    if (loading) return;
    if ((view === 'meeting' && !current) || (view === 'project' && !allProjects.includes(project))) go('recent');
  }, [loading, view, current, project, allProjects, go]);
  const blocked = Boolean(dialog || capture);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || blocked) return;
      const key = event.key.toLowerCase();
      if (key === 'k' && (event.target as HTMLElement | null)?.closest?.('.ProseMirror')) return;
      if (key === 'k' || key === 'p' || (event.shiftKey && key === 'f')) { event.preventDefault(); setView('search'); searchInput.current?.select(); }
      else if (key === 'n') { event.preventDefault(); newMeeting(); }
      else if (event.shiftKey && key === 'm') { event.preventDefault(); window.dispatchEvent(new CustomEvent('toggle-source-mode')); }
      else if (key === ',') { event.preventDefault(); setView('settings'); }
      else if (key === '\\' || (event.shiftKey && key === 'enter')) { event.preventDefault(); setReview(v => !v); }
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
    setProjects(p => [...p, name]); setDialog(''); go('project', name);
  }
  async function createMeeting(title: string, meetingProject: string) {
    const meeting = makeMeeting(title, meetingProject);
    await storage.createMeeting(meeting);
    upsert(meeting); remember(lastProjectKey, meetingProject); setDialog(''); openMeeting(meeting.metadata.id);
  }
  async function addExamples() {
    setAddingExamples(true);
    try { await storage.addExamples(records.current.map(m => m.metadata.id)); await load(); go('recent'); }
    catch (e) { setProblem(`Couldn’t add the example meetings. ${String(e)}`); }
    finally { setAddingExamples(false); }
  }
  async function markEnded(meeting: Meeting) {
    const next: Meeting = { ...meeting, metadata: { ...meeting.metadata, status: 'ready', captureEndedAt: meeting.metadata.captureEndedAt ?? new Date().toISOString() } };
    try { await storage.saveMetadata(next.metadata); upsert(next); }
    catch (e) { setProblem(`Couldn’t update this meeting. ${String(e)}`); }
  }
  async function openArchive() {
    try { await storage.openArchive(); } catch (e) { setProblem(`Couldn’t open the archive folder. ${String(e)}`); }
  }
  const dialogs = <>
    {dialog === 'project' && <NewProjectDialog existing={allProjects} onCreate={createProject} onClose={() => setDialog('')} />}
    {dialog === 'meeting' && <NewMeetingDialog projects={allProjects} project={contextProject} onCreate={createMeeting} onClose={() => setDialog('')} />}
  </>;
  if (loading && !meetings.length) return <div className="quietnote-shell centered" data-tauri-drag-region><p className="subtle" role="status">Opening your meetings…</p></div>;
  if (loadError) return <div className="quietnote-shell centered" data-tauri-drag-region><div className="load-error" role="alert">
    <h1>We couldn’t open your meeting archive.</h1>
    <p>Your files haven’t been changed. Try again, or check the archive folder.</p>
    <div className="button-row"><button className="primary" onClick={() => void load()}>Retry</button>{storage.desktop && <button className="secondary" onClick={() => void openArchive()}>Open archive location</button>}</div>
    <details className="advanced"><summary>View details</summary><p className="path">{loadError}</p></details>
    {problem && <p className="field-error">{problem}</p>}
  </div></div>;
  if (!allProjects.length && !meetings.length) return <div className="quietnote-shell centered"><Welcome busy={addingExamples} onCreate={() => setDialog('project')} onExamples={() => void addExamples()} />{problem && <p className="field-error floating" role="alert">{problem}</p>}{dialogs}</div>;
  const libraryMeetings = view === 'project' ? sorted.filter(m => m.metadata.project === project) : view === 'recent' ? sorted.slice(0, 10) : sorted;
  const count = (n: number) => `${n} ${n === 1 ? 'meeting' : 'meetings'}`;
  const saveText = saveState === 'saving' ? 'Saving…' : saveState === 'unsaved' ? 'Not saved' : storage.desktop ? 'Saved' : 'Saved in this browser';
  const navItem = (active: boolean, icon: Parameters<typeof Icon>[0]['name'], label: string, onClick: () => void, extra?: ReactNode, className = '') =>
    <button className={`sidebar-item ${className} ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} title={label} onClick={onClick}><Icon name={icon} size={16} /><span className="label">{label}</span>{extra}</button>;
  return <div className={`quietnote-shell ${review ? 'review-mode' : ''} ${showKeys ? 'show-keys' : ''}`}>
    <aside className="qn-sidebar" aria-label="Main navigation">
      <div className="sidebar-drag" data-tauri-drag-region />
      <div className="sidebar-top">
        <button className="brand" aria-label="QuietNote" onClick={() => go('recent')}><Logo /><span className="label">QuietNote</span></button>
        <button className="primary new-meeting" title="New meeting (⌘N)" onClick={newMeeting}><Icon name="plus" size={16} /><span className="label">New meeting</span><kbd aria-hidden="true">⌘N</kbd></button>
      </div>
      <nav className="sidebar-scroll" aria-label="Meetings and projects">
        <h2 className="sidebar-label">Meetings</h2>
        {navItem(view === 'recent', 'recent', 'Recent', () => go('recent'))}
        {navItem(view === 'all', 'meeting', 'All meetings', () => go('all'))}
        <div className="sidebar-label-row"><h2 className="sidebar-label">Projects</h2><button className="icon-button small" aria-label="New project" title="New project" onClick={() => setDialog('project')}><Icon name="plus" size={14} /></button></div>
        {allProjects.map((p, i) => <div key={p}>{navItem(view === 'project' && project === p, 'folder', p, () => go('project', p), <><span className="initial" aria-hidden="true">{p.slice(0, 1).toUpperCase()}</span>{i < 9 && <kbd aria-hidden="true">⌘{i + 1}</kbd>}<span className="sidebar-count">{meetings.filter(m => m.metadata.project === p).length || ''}</span></>, 'project-item')}</div>)}
      </nav>
      <div className="sidebar-bottom">
        {navItem(view === 'search', 'search', 'Search', () => setView('search'), <kbd aria-hidden="true">⌘K</kbd>)}
        {navItem(view === 'settings', 'settings', 'Settings', () => setView('settings'), <kbd aria-hidden="true">⌘,</kbd>)}
      </div>
      <SidebarResizeHandle />
    </aside>
    <div className="qn-workspace">
      <header className="window-bar" data-tauri-drag-region>
        <div className="window-context">{review && <button className="text-button" onClick={() => setReview(false)}><Icon name="back" size={15} />Show sidebar</button>}{view === 'meeting' && current && <button className="text-button" onClick={() => go('project', current.metadata.project)}><Icon name="folder" size={15} />{current.metadata.project}</button>}</div>
        <div className={`save-status ${saveState}`} role="status" aria-live="polite"><i aria-hidden="true" />{saveText}{!storage.desktop && <span className="badge">Browser preview</span>}</div>
      </header>
      {unsaved && <div className="banner warning" role="alert">
        <div><strong>{unsaved === 'recovered' ? 'Recovered unsaved changes from your last session.' : storage.desktop ? 'Your latest changes haven’t been saved to disk.' : 'Your latest changes haven’t been saved in this browser.'}</strong><span>{unsaved === 'recovered' ? 'They’re shown in your notes but not yet written to the archive.' : 'A draft copy is kept. Nothing is lost while this window stays open.'}</span>{unsaved === 'failed' && saveDetail && <details><summary>Details</summary>{saveDetail}</details>}</div>
        <div className="banner-actions"><button className="primary" onClick={() => void retry()}>{unsaved === 'recovered' ? 'Save now' : 'Retry'}</button>{confirmDiscard ? <button className="secondary danger" onClick={() => void discard()}>Discard changes</button> : <button className="secondary" onClick={() => setConfirmDiscard(true)}>{unsaved === 'recovered' ? 'Discard' : 'Reload saved version'}</button>}</div>
      </div>}
      {external && !unsaved && <div className="banner" role="status"><div><strong>Files changed outside QuietNote.</strong><span>Refresh to load the latest version from disk.</span></div><div className="banner-actions"><button className="secondary" onClick={() => void reload()}>Refresh</button></div></div>}
      {problem && <div className="banner warning" role="alert"><div><strong>{problem}</strong></div><div className="banner-actions"><button className="text-button" onClick={() => setProblem('')}>Dismiss</button></div></div>}
      <main className="qn-main" ref={main}>
        {view === 'settings' ? <Settings section={settingsSection} onSection={setSettingsSection} values={preferences} onChange={changePreference} root={root} hasAllExamples={demoMeetings.every(d => meetings.some(m => m.metadata.id === d.metadata.id))} onOpenArchive={() => void openArchive()} onReload={() => void reload()} onWorkspace={() => { window.location.href = '?workspace=markdown'; }} onExamples={() => void addExamples()} />
        : view === 'meeting' && current ? <MeetingDetail key={`${current.metadata.id}-${reloadKey}`} meeting={current} example={isExample(current.metadata.id)} tab={tab} onTab={setTab} onStartCapture={() => setCapture({ id: current.metadata.id, auto: preferences.confirm === false })} onMarkEnded={() => void markEnded(current)} onDraft={notes => backupNotes(current.metadata.id, notes)} onMarkdown={markdown => persist(current.metadata.id, markdown)} onNotes={notes => {
          const latest = records.current.find(m => m.metadata.id === current.metadata.id)!;
          return persist(current.metadata.id, replaceSection(latest.markdown, 'Notes', notes));
        }} />
        : view === 'search' ? <div className="page search-page">
          <label className="search-field"><Icon name="search" size={18} /><input ref={searchInput} type="search" aria-label="Search meetings" placeholder="Search meetings…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && results[0]) openMeeting(results[0].meeting.metadata.id, results[0].tab); }} /></label>
          {!query.trim() ? <p className="subtle">Search titles, summaries, decisions, action items, notes and transcripts.</p>
          : results.length ? <><p className="result-count" role="status">{results.length === 1 ? '1 meeting' : `${results.length} meetings`}</p><ul className="results">{results.map(({ meeting, tab: hitTab, snippet }) => <li key={meeting.metadata.id}><button className="result" onClick={() => openMeeting(meeting.metadata.id, hitTab)}>
            <strong><Highlight text={meeting.metadata.title} terms={searchTerms(query)} /></strong>
            <span className="result-meta">{shortDate(meeting.metadata.date)} · {meeting.metadata.project}{hitTab !== 'Summary' && ` · in ${hitTab}`}</span>
            {snippet && <span className="snippet"><Highlight text={snippet} terms={searchTerms(query)} /></span>}
          </button></li>)}</ul></>
          : <div className="empty-inline" role="status"><h2>No meetings found for ‘{query.trim()}’.</h2><p>Try another term.</p></div>}
        </div>
        : <div className="page library-page">
          <header className="page-header"><div><h1>{view === 'project' ? project : view === 'all' ? 'All meetings' : 'Recent'}</h1>{libraryMeetings.length > 0 && <p className="subtle">{view === 'recent' ? 'Your latest meetings' : count(libraryMeetings.length)}</p>}</div></header>
          {libraryMeetings.length ? <MeetingList meetings={libraryMeetings} showProject={view !== 'project'} onOpen={openMeeting} />
          : <div className="empty-state"><h2>{view === 'project' ? 'Nothing here yet.' : 'No meetings yet.'}</h2><p>{view === 'project' ? `Meetings for ${project} will appear here.` : 'Create a meeting to start keeping notes.'}</p><button className="secondary" onClick={() => view === 'project' ? setDialog('meeting') : newMeeting()}><Icon name="plus" size={15} />New meeting</button></div>}
          {view === 'recent' && sorted.length > libraryMeetings.length && <button className="text-button see-all" onClick={() => go('all')}>All {count(sorted.length)}<Icon name="arrow" size={14} /></button>}
        </div>}
      </main>
    </div>
    {dialogs}
    {capture && (() => {
      const meeting = meetings.find(m => m.metadata.id === capture.id);
      return meeting && <Capture meeting={meeting} autoStart={capture.auto} onUpdated={upsert} onClose={() => setCapture(null)} onAddNotes={() => { setCapture(null); openMeeting(meeting.metadata.id, 'Notes'); }} />;
    })()}
  </div>;
}
export default function QuietNoteApp() { return <ThemeProvider><TooltipProvider><Shell /><Toaster /></TooltipProvider></ThemeProvider>; }
