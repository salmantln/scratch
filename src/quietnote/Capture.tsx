import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Icon, Pulse } from './Icon';
import { makeMeeting, projects, type Meeting } from './model';
import * as storage from './storage';
export function Capture({ onClose, onCreated, onUpdated, onOpen, confirm }: {
  onClose: () => void; onCreated: (meeting: Meeting) => void; onUpdated: (meeting: Meeting) => void; onOpen: (id: string) => void; confirm: boolean;
}) {
  const [title, setTitle] = useState('');
  const [project, setProject] = useState('Internal');
  const [record, setRecord] = useState<Meeting | null>(null);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const elapsedRef = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  const phase = record?.metadata.status ?? 'idle';
  const active = phase === 'recording' || phase === 'processing';
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    if (phase !== 'recording' || paused) return;
    const started = Date.now() - elapsedRef.current * 1000;
    const timer = window.setInterval(() => { elapsedRef.current = Math.floor((Date.now() - started) / 1000); setElapsed(elapsedRef.current); }, 250);
    return () => clearInterval(timer);
  }, [phase, paused]);
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);
  useEffect(() => {
    if (!storage.desktop || !active) return;
    let cancelled = false; let unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(event => {
      event.preventDefault(); setError('Stop the prototype capture before closing QuietNote.');
    }).then(fn => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, [active]);
  async function start() {
    setBusy(true); setError('');
    const meeting = makeMeeting(title.trim() || 'Untitled meeting', project);
    meeting.metadata.status = 'recording'; meeting.metadata.captureStartedAt = new Date().toISOString();
    try { await storage.createMeeting(meeting); setRecord(meeting); onCreated(meeting); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function stop() {
    if (!record) return;
    setBusy(true); setError('');
    const processing: Meeting = { ...record, metadata: { ...record.metadata, status: 'processing', duration: elapsedRef.current, captureEndedAt: new Date().toISOString() } };
    try {
      await storage.saveMetadata(processing.metadata); setRecord(processing); onUpdated(processing);
      await new Promise(resolve => window.setTimeout(resolve, 1400));
      const ready: Meeting = { ...processing, metadata: { ...processing.metadata, status: 'ready' } };
      await storage.saveMetadata(ready.metadata); setRecord(ready); onUpdated(ready);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <div className="capture-backdrop"><div className="capture-panel" role="dialog" aria-modal="true" aria-labelledby="capture-heading" ref={panel} onKeyDown={e => {
    if (e.key === 'Escape' && !active && !busy) onClose();
    if (e.key === 'Tab') {
      const focusable = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')];
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  }}>
    <div className="capture-heading"><Pulse /><span className="eyebrow">YOUR MEETING, YOUR CALL</span>{!active && <button className="icon-button" aria-label="Close capture" disabled={busy} onClick={onClose}><Icon name="close" /></button>}</div>
    <h2 id="capture-heading">{phase === 'idle' ? 'A little less to remember.' : phase === 'ready' ? 'Notes ready' : phase === 'processing' ? 'Preparing your notes…' : title.trim() || 'Untitled meeting'}</h2>
    <p className="capture-description">{phase === 'idle' ? 'Start when you’re ready. Stay in the conversation.' : phase === 'ready' ? 'Your meeting record is in your local archive.' : 'A quiet space for this conversation.'}</p>
    <div className="prototype-notice"><span className="prototype-badge">Prototype</span> {phase === 'ready' ? 'An editable record was created. No AI summary or audio.' : 'Simulated capture. No audio is recorded or transmitted.'}</div>
    {phase === 'idle' ? <form onSubmit={e => { e.preventDefault(); void start(); }}>
      <label>Meeting title<input autoFocus placeholder="e.g. Acme onboarding call" value={title} maxLength={160} onChange={e => setTitle(e.target.value)} /></label>
      <label>Project<select value={project} onChange={e => setProject(e.target.value)}>{projects.map(p => <option key={p}>{p}</option>)}</select></label>
      <label>Audio source<span className="source-placeholder"><Icon name="monitor" /> System audio + microphone <span>Planned</span></span></label>
      {confirm && <label className="confirm-capture"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I’m ready to start this prototype capture.</label>}
      <button className="primary full" type="submit" disabled={busy || (confirm && !confirmed)}><Icon name="mic" />{busy ? 'Creating meeting…' : 'Start capture'}</button>
    </form> : <>
      <div className={`capture-clock ${paused ? 'paused' : ''}`}>{phase === 'recording' ? paused ? 'Paused' : 'Recording' : phase === 'ready' ? 'Saved' : 'Processing'}<strong>{[Math.floor(elapsed / 3600), Math.floor(elapsed / 60) % 60, elapsed % 60].map(n => String(n).padStart(2, '0')).join(':')}</strong></div>
      <div className={`waveform ${paused ? 'paused' : ''}`} aria-label="Illustrative waveform">{Array.from({ length: 45 }, (_, i) => <i key={i} style={{ height: `${10 + ((i * 17 + i * i * 3) % 42)}px` }} />)}</div>
      <div className="capture-properties"><span><Icon name="check" />Recording started by you</span><span><Icon name="shield" />No bot joined</span></div>
      {phase === 'recording' && <div className="capture-controls"><button className="secondary" disabled={busy} onClick={() => setPaused(!paused)}><Icon name={paused ? 'play' : 'pause'} />{paused ? 'Resume' : 'Pause'}</button><button className="primary" disabled={busy} onClick={() => void stop()}><Icon name="stop" />Stop capture</button></div>}
      {phase === 'processing' && <p className="processing-label" role="status"><Pulse small />Preparing prototype record…</p>}
      {phase === 'ready' && <button className="primary full" onClick={() => { onOpen(record!.metadata.id); onClose(); }}>Open meeting<Icon name="arrow" /></button>}
    </>}
    {error && <div className="inline-error" role="alert">{error}{phase === 'processing' && <button onClick={() => void stop()}>Retry</button>}</div>}
    <div className="capture-footnote"><Icon name="shield" size={14} /> No extra attendee. You’re in control.</div>
  </div></div>;
}
