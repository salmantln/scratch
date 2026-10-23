import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { timeLabel, validProjectName, type CalendarEvent } from './model';
export function Modal({ title, onEscape, children, className = '' }: { title: ReactNode; onEscape?: () => void; children: ReactNode; className?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const heading = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('[data-autofocus], input, button:not(:disabled)')?.focus();
    return () => previous?.focus();
  }, []);
  // Listens on the window so Escape still works after focus leaves the panel (a click on text, a button that disabled itself).
  useEffect(() => {
    if (!onEscape) return;
    const escape = (e: KeyboardEvent) => {
      const modals = document.querySelectorAll('.modal');
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || modals[modals.length - 1] !== panel.current) return;
      e.preventDefault(); onEscape();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onEscape]);
  return <div className="modal-backdrop"><div className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={heading} ref={panel} onKeyDown={e => {
    if (e.key === 'Tab') {
      const focusable = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary')];
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  }}><h2 id={heading}>{title}</h2>{children}</div></div>;
}
export function NewProjectDialog({ existing, onCreate, onClose }: { existing: string[]; onCreate: (name: string) => Promise<void>; onClose: () => void }) {
  const id = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    const problem = validProjectName(name) || (existing.some(p => p.toLowerCase() === name.trim().toLowerCase()) ? 'A project with this name already exists.' : '');
    if (problem) { setError(problem); return; }
    setBusy(true);
    try { await onCreate(name.trim()); }
    catch (e) { setError(`Couldn’t create the project. ${String(e).replace(/^Error: /, '')}`); setBusy(false); }
  }
  return <Modal title="New project" onEscape={busy ? undefined : onClose}>
    <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="field"><label htmlFor={id}>Project name</label><input id={id} value={name} maxLength={60} placeholder="e.g. Acme" aria-invalid={Boolean(error)} aria-describedby={error ? 'project-error' : undefined} onChange={e => { setName(e.target.value); setError(''); }} /></div>
      {error && <p className="field-error" id="project-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create project'}</button></div>
    </form>
  </Modal>;
}
/** With `canRecord`, the primary action creates the meeting and starts recording it: that press is the explicit start.
 * With a calendar `event` (the one happening now, or the tray's), the title, project and who's invited come from
 * it until the user types over them or chooses not to use it. It may arrive after the dialog opens. */
export function NewMeetingDialog({ projects, project: initial, canRecord = false, event = null, projectFor, onCreate, onClose }: {
  projects: string[]; project: string; canRecord?: boolean; event?: CalendarEvent | null; projectFor?: (event: CalendarEvent) => string;
  onCreate: (title: string, project: string, record: boolean, event: CalendarEvent | null) => Promise<void>; onClose: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState('');
  const [project, setProject] = useState(projects.includes(initial) ? initial : projects[0]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'create' | 'record'>('');
  const [touched, setTouched] = useState({ title: false, project: false });
  const [using, setUsing] = useState(true);
  const from = using ? event : null;
  useEffect(() => {
    if (!event) return;
    if (!touched.title) setTitle(event.title);
    const suggested = projectFor?.(event);
    if (!touched.project && suggested && projects.includes(suggested)) setProject(suggested);
    // Only when the event itself arrives or changes; later edits are the user's.
  }, [event?.id]);
  async function submit(record: boolean) {
    setBusy(record ? 'record' : 'create'); setError('');
    try { await onCreate(title.trim() || 'Untitled meeting', project, record, from); }
    catch (e) { setError(`Couldn’t create the meeting. ${String(e).replace(/^Error: /, '')}`); setBusy(''); }
  }
  const invited = from ? from.attendees.filter(a => !a.me).length : 0;
  return <Modal title="New meeting" onEscape={busy ? undefined : onClose}>
    <form onSubmit={e => { e.preventDefault(); void submit(canRecord); }}>
      <div className="field"><label htmlFor={`${id}-title`}>Meeting title</label><input id={`${id}-title`} value={title} maxLength={160} placeholder="Untitled meeting" onChange={e => { setTitle(e.target.value); setTouched(t => ({ ...t, title: true })); }} />
        {from && <p className="subtle from-calendar">From your calendar · {timeLabel(new Date(from.startMs).toISOString())}–{timeLabel(new Date(from.endMs).toISOString())}{invited > 0 && ` · ${invited} ${invited === 1 ? 'other person' : 'others'}`} <button type="button" className="text-button" onClick={() => { setUsing(false); if (!touched.title) setTitle(''); }}>Don’t use</button></p>}</div>
      <div className="field"><label htmlFor={`${id}-project`}>Project</label><select id={`${id}-project`} value={project} onChange={e => { setProject(e.target.value); setTouched(t => ({ ...t, project: true })); }}>{projects.map(p => <option key={p}>{p}</option>)}</select></div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={Boolean(busy)} onClick={onClose}>Cancel</button>
        {canRecord && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void submit(false)}>{busy === 'create' ? 'Creating…' : 'Create meeting'}</button>}
        <button type="submit" className="primary" disabled={Boolean(busy)}>{canRecord ? (busy === 'record' ? 'Starting…' : 'Start recording') : busy ? 'Creating…' : 'Create meeting'}</button></div>
    </form>
  </Modal>;
}
