import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { ThemeProvider } from '../context/ThemeContext';
import { TooltipProvider, Toaster } from '../components/ui';
import { SidebarResizeHandle } from '../components/layout/SidebarResizeHandle';
import { Icon, Logo, Pulse } from './Icon';
import { Capture } from './Capture';
import { Privacy } from './Privacy';
import { MeetingDetail, type MeetingTab } from './MeetingDetail';
import { dateLabel, durationLabel, matchesMeeting, projects, replaceSection, type Meeting } from './model';
import * as storage from './storage';
import './quietnote.css';

type View = 'library' | 'meeting' | 'settings' | 'search';
function Shell() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const records = useRef<Meeting[]>([]);
  const [root, setRoot] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState('Saved locally');
  const [view, setView] = useState<View>('library');
  const [selected, setSelected] = useState('');
  const [project, setProject] = useState('All projects');
  const [query, setQuery] = useState('');
  const [indexedIds, setIndexedIds] = useState<string[]>([]);
  const [tab, setTab] = useState<MeetingTab>('Summary');
  const [capture, setCapture] = useState(false);
  const [review, setReview] = useState(false);
  const [preferences, setPreferences] = useState<storage.PrivacyPreferences>({});
  const [sort, setSort] = useState('newest');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const dirty = useRef(new Map<string, string>());
  const queue = useRef(Promise.resolve());
  const searchInput = useRef<HTMLInputElement>(null);
  const main = useRef<HTMLElement>(null);
  const setRecords = useCallback((next: Meeting[]) => { records.current = next; setMeetings(next); }, []);
  const upsert = useCallback((meeting: Meeting) => { setRecords([meeting, ...records.current.filter(m => m.metadata.id !== meeting.metadata.id)]); }, [setRecords]);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const archive = await storage.loadArchive();
      // Recover drafts left by a failed save or an interrupted session.
      let recovered = false;
      const restored = archive.meetings.map(m => {
        const draft = localStorage.getItem(`quietnote.draft.${m.metadata.id}`);
        if (draft !== null) { dirty.current.set(m.metadata.id, draft); recovered = true; return { ...m, markdown: draft }; }
        if (m.metadata.status === 'recording' || m.metadata.status === 'processing') {
          return { ...m, metadata: { ...m.metadata, status: 'error' as const } };
        }
        return m;
      });
      setRoot(archive.root); setRecords(restored);
      if (recovered) { setError('Recovered unsaved edits. Retry save to write them to the archive.'); setSaveState('Unsaved changes'); }
      setPreferences(await storage.preferences());
    } catch (e) { setError(`Couldn’t open your archive: ${String(e)}`); }
    finally { setLoading(false); }
  }, [setRecords]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { main.current?.scrollTo(0, 0); }, [selected, view, project]);
  useEffect(() => {
    if (view === 'search') searchInput.current?.focus();
  }, [view]);
  useEffect(() => {
    let cancelled = false;
    setIndexedIds([]);
    if (!query.trim()) return;
    const timer = window.setTimeout(() => { storage.indexedSearch(query).then(ids => { if (!cancelled) setIndexedIds(ids); }).catch(() => { /* Full-content local matching remains available. */ }); }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || capture) return;
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); setCapture(true); }
      if (event.key.toLowerCase() === 'p' || (event.shiftKey && event.key.toLowerCase() === 'f')) { event.preventDefault(); setProject('All projects'); setView('search'); }
      if (event.shiftKey && event.key.toLowerCase() === 'm') { event.preventDefault(); window.dispatchEvent(new CustomEvent('toggle-source-mode')); }
      if (event.key === ',') { event.preventDefault(); setView('settings'); }
      if (event.key === '\\' || (event.shiftKey && event.key === 'Enter')) { event.preventDefault(); setReview(v => !v); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [capture]);
  // A watcher notification prompts an explicit reload, avoiding overwrites of an active editor.
  useEffect(() => {
    if (!storage.desktop) return;
    let cancelled = false; let unlisten: (() => void) | undefined;
    listen('file-change', () => setRefreshVersion(v => v + 1)).then(fn => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);
  const persist = useCallback((id: string, markdown: string) => {
    const meeting = records.current.find(m => m.metadata.id === id);
    if (!meeting) return Promise.resolve();
    try { localStorage.setItem(`quietnote.draft.${id}`, markdown); }
    catch { setError('Draft backup is unavailable. Keep this window open until the local save completes.'); }
    dirty.current.set(id, markdown);
    upsert({ ...meeting, markdown }); setSaveState('Saving…');
    queue.current = queue.current.then(async () => {
      try {
        await storage.saveMarkdown(meeting.metadata, markdown);
        if (dirty.current.get(id) === markdown) { dirty.current.delete(id); localStorage.removeItem(`quietnote.draft.${id}`); }
        if (!dirty.current.size) { setSaveState('Saved locally'); setError(''); }
      } catch (e) { setSaveState('Unsaved changes'); setError(`Couldn’t save your edits: ${String(e)}. Your draft is retained; retry below.`); }
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
    dirty.current.set(id, markdown); setSaveState('Saving…');
    try { localStorage.setItem(`quietnote.draft.${id}`, markdown); }
    catch { setError('Draft backup is unavailable. Keep this window open until the local save completes.'); }
  }
  async function retry() {
    if (!dirty.current.size) { await load(); return; }
    await Promise.all([...dirty.current].map(([id, markdown]) => persist(id, markdown)));
  }
  async function reload() {
    await queue.current;
    if (dirty.current.size) { setError('Save your pending edits before reloading the archive.'); return; }
    await load(); setRefreshVersion(0); setReloadKey(v => v + 1);
  }
  function changePreference(key: string, value: boolean | string) {
    const next = { ...preferences, [key]: value }; setPreferences(next);
    queue.current = queue.current.then(async () => { try { await storage.preferences(next); } catch (e) { setError(`Couldn’t save privacy preferences: ${String(e)}`); } });
  }
  function openMeeting(id: string) { setSelected(id); setTab('Summary'); setView('meeting'); }
  function openLibrary(p = 'All projects') { setProject(p); setQuery(''); setView('library'); setReview(false); }
  const sorted = useMemo(() => [...meetings].sort((a, b) => b.metadata.date.localeCompare(a.metadata.date)), [meetings]);
  const filtered = sorted.filter(m => (project === 'All projects' || m.metadata.project === project) && (matchesMeeting(m, query) || indexedIds.includes(m.metadata.id)));
  if (sort === 'oldest') filtered.reverse();
  const current = meetings.find(m => m.metadata.id === selected);
  const allProjects = [...new Set([...projects, ...meetings.map(m => m.metadata.project)])];
  return <div className={`quietnote-shell ${review ? 'review-mode' : ''}`}>
    <aside className="qn-sidebar" aria-label="Main navigation">
      <div className="sidebar-drag" data-tauri-drag-region />
      <div className="sidebar-top"><button className="brand" onClick={() => openLibrary()}><Logo /><span>QuietNote<span className="brand-period">.</span></span></button>
      <button className="primary new-capture" onClick={() => setCapture(true)}><Icon name="plus" />New capture<kbd>⌘ N</kbd></button></div>
      <nav className="sidebar-scroll" aria-label="Meetings and projects"><button className={`sidebar-item library-link ${view === 'library' && project === 'All projects' ? 'active' : ''}`} onClick={() => openLibrary()}><Icon name="meetings" />Meetings<span className="sidebar-count">{meetings.length}</span></button>
      <div className="sidebar-label">RECENT</div>
      <div className="recent-meetings">{sorted.slice(0, 4).map(m => <button title={m.metadata.title} key={m.metadata.id} className={`sidebar-item recent ${view === 'meeting' && selected === m.metadata.id ? 'active' : ''}`} onClick={() => openMeeting(m.metadata.id)}><span>{m.metadata.title}</span></button>)}</div>
      <div className="sidebar-label projects-label">PROJECTS</div>
      {allProjects.map(p => <button key={p} className={`sidebar-item ${project === p && view === 'library' ? 'active' : ''}`} onClick={() => openLibrary(p)}><span className={`project-dot ${p.toLowerCase()}`} />{p}<span className="sidebar-count">{meetings.filter(m => m.metadata.project === p).length}</span></button>)}</nav>
      <div className="sidebar-bottom"><button className={`sidebar-item ${view === 'search' ? 'active' : ''}`} onClick={() => { setProject('All projects'); setView('search'); }}><Icon name="search" />Search<kbd>⌘ P</kbd></button><button className={`sidebar-item ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}><Icon name="settings" />Settings<kbd>⌘ ,</kbd></button><div className="local-indicator">{storage.desktop ? 'Local workspace' : 'Browser preview'}<Icon name="shield" size={14} /></div></div>
      <SidebarResizeHandle />
    </aside>
    <div className="qn-workspace"><header className="window-bar" data-tauri-drag-region><div>{review && <button className="text-button" onClick={() => setReview(false)}><Icon name="back" />Exit review</button>}<span>Workspace</span><Icon name="chevron" size={12} /><span>{view === 'settings' ? 'Settings' : view === 'search' ? 'Search' : 'Meetings'}</span></div><div className="window-status">{storage.desktop ? saveState : saveState === 'Saved locally' ? 'Saved in this browser' : saveState}<button className="icon-button" aria-label="Reload local archive" title={refreshVersion ? 'Refresh files from disk' : 'Reload local archive'} onClick={() => void reload()}><Icon name="refresh" size={15} /></button></div></header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => void retry()}>Retry {dirty.current.size ? 'save' : 'load'}</button></div>}
    <main className="qn-main" ref={main}>
      {loading ? <div className="loading-state"><Pulse /><p>Opening your local archive…</p></div> : view === 'settings' ? <Privacy values={preferences} onChange={changePreference} root={root} onWorkspace={() => { window.location.href = '?workspace=markdown'; }} /> : view === 'meeting' && current ? <MeetingDetail key={`${current.metadata.id}-${reloadKey}`} meeting={current} tab={tab} onTab={setTab} onBack={() => openLibrary()} review={review} onReview={() => setReview(!review)} onDraft={notes => backupNotes(current.metadata.id, notes)} onMarkdown={markdown => persist(current.metadata.id, markdown)} onNotes={notes => {
        const latest = records.current.find(m => m.metadata.id === current.metadata.id)!;
        return persist(current.metadata.id, replaceSection(latest.markdown, 'Notes', notes));
      }} /> : <article className="library-page"><div className="library-heading"><div><div className="eyebrow">YOUR LOCAL ARCHIVE</div><h1>{view === 'search' ? 'Find a conversation.' : project === 'All projects' ? 'Meetings' : project}</h1><p className="page-description">{view === 'search' ? 'The decisions, details, and next steps. All in one place.' : 'Less to hold in your head. More to come back to.'}</p></div><div className="library-motif" aria-hidden="true"><Pulse /></div></div>
      <div className="library-tools"><label className="meeting-search"><Icon name="search" size={17} /><input ref={searchInput} aria-label="Search meetings" placeholder="Search meetings…" value={query} onChange={e => setQuery(e.target.value)} /><kbd>⌘ P</kbd></label><select aria-label="Filter by project" value={project} onChange={e => setProject(e.target.value)}><option>All projects</option>{allProjects.map(p => <option key={p}>{p}</option>)}</select><select aria-label="Sort meetings" value={sort} onChange={e => setSort(e.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></div>
      <div className="library-list-heading"><span>{query ? `${filtered.length} RESULTS` : 'ALL MEETINGS'}<b>{!query && filtered.length}</b></span><span>{query ? 'Includes notes & transcripts' : 'A little clarity after every call'}</span></div>
      <div className="meeting-table"><div className="meeting-table-head"><span>Meeting</span><span>Project</span><span>Date</span><span>Duration</span><span>Status</span><span /></div>{filtered.map(m => <button className="meeting-row" key={m.metadata.id} onClick={() => openMeeting(m.metadata.id)}><span className="meeting-row-title"><span className="meeting-file-icon"><Icon name="meetings" size={19} /></span><span><strong>{m.metadata.title}</strong><span className="row-tags">{m.metadata.tags.join(' · ')}</span></span></span><span className="row-project"><span className={`project-dot ${m.metadata.project.toLowerCase()}`} />{m.metadata.project}</span><span className="row-date">{dateLabel(m.metadata.date).replace(' 2026', '')}</span><span className="row-duration">{durationLabel(m.metadata.duration)}</span><span className={`status-badge ${m.metadata.status}`}>{m.metadata.status}</span><Icon name="chevron" size={15} /></button>)}</div>
      {!filtered.length && <div className="empty-state"><Pulse /><h2>{query ? 'No meetings found' : 'Room for your next conversation.'}</h2><p>{query ? 'Try a client name, a decision, or a phrase from your notes.' : 'Start a capture to create your first meeting record.'}</p><button className="secondary" onClick={() => query ? setQuery('') : setCapture(true)}>{query ? 'Clear search' : 'New capture'}</button></div>}
      <div className="library-footer"><span><Icon name="shield" size={15} />{storage.desktop ? 'On your device. At your pace.' : 'Browser preview · desktop uses local Markdown files'}</span><span>6 sample meetings included · Prototype</span></div>
      <div className="library-bottom-note"><span className="quiet-rule" /><p>Be in the meeting.<br /><strong>Leave the remembering here.</strong></p></div>
      </article>}
    </main></div>
    {capture && <Capture confirm={preferences.confirm !== false} onClose={() => setCapture(false)} onCreated={upsert} onUpdated={upsert} onOpen={openMeeting} />}
  </div>;
}
export default function QuietNoteApp() { return <ThemeProvider><TooltipProvider><Shell /><Toaster /></TooltipProvider></ThemeProvider>; }
