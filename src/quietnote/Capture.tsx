import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Icon } from './Icon';
import { Modal } from './Dialogs';
import type { Meeting } from './model';
import * as storage from './storage';
const clock = (seconds: number) => [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
// Prototype capture: it tracks a real session (start, elapsed time, stop) but records no audio.
export function Capture({ meeting, autoStart, onUpdated, onClose, onAddNotes }: {
  meeting: Meeting; autoStart: boolean; onUpdated: (meeting: Meeting) => void; onClose: () => void; onAddNotes: () => void;
}) {
  const [record, setRecord] = useState(meeting);
  const [phase, setPhase] = useState<'ready' | 'capturing' | 'ended'>('ready');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(0);
  const autoStarted = useRef(false);
  const capturing = phase === 'capturing';
  useEffect(() => {
    if (!capturing) return;
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 250);
    return () => clearInterval(timer);
  }, [capturing]);
  useEffect(() => {
    if (!capturing) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [capturing]);
  useEffect(() => {
    if (!storage.desktop || !capturing) return;
    let cancelled = false; let unlisten: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(event => {
      event.preventDefault(); setError('Stop capture before closing QuietNote.');
    }).then(fn => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, [capturing]);
  async function save(next: Meeting) {
    await storage.saveMetadata(next.metadata); setRecord(next); onUpdated(next);
  }
  async function start() {
    setBusy(true); setError('');
    try {
      await save({ ...record, metadata: { ...record.metadata, status: 'recording', captureStartedAt: new Date().toISOString() } });
      started.current = Date.now(); setElapsed(0); setPhase('capturing');
    } catch (e) { setError(`Couldn’t start capture. ${String(e)}`); }
    finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true); setError('');
    const duration = Math.floor((Date.now() - started.current) / 1000);
    try {
      await save({ ...record, metadata: { ...record.metadata, status: 'ready', duration, captureEndedAt: new Date().toISOString() } });
      setElapsed(duration); setPhase('ended');
    } catch (e) { setError(`Couldn’t save the end of capture. Try again. ${String(e)}`); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (autoStart && !autoStarted.current) { autoStarted.current = true; void start(); }
  }, []);
  // Keep focus on the one primary control as it changes between Start, Stop and Add notes.
  useEffect(() => { document.querySelector<HTMLElement>('.modal.capture [data-autofocus]')?.focus(); }, [phase, busy]);
  return <Modal className="capture" title={record.metadata.title} onEscape={capturing || busy ? undefined : onClose}>
    <p className="capture-project"><Icon name="folder" size={14} />{record.metadata.project}</p>
    <p className="prototype-line"><span className="badge">Prototype</span>This version does not record audio.</p>
    <div key={phase} className={`capture-status ${phase}`} role="status">
      <span className="capture-state">{phase === 'capturing' ? <><i className="live-dot" aria-hidden="true" />Capturing</> : phase === 'ended' ? 'Capture ended' : 'Not capturing'}</span>
      <strong aria-label={`Elapsed time ${clock(elapsed)}`}>{clock(elapsed)}</strong>
      <span className="capture-facts">{phase === 'ended' ? 'No audio was recorded. Add your notes while the meeting is fresh.' : 'Started by you · No bot joins the call'}</span>
    </div>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="modal-actions">
      {phase === 'ready' && <><button className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" data-autofocus disabled={busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Start capture'}</button></>}
      {phase === 'capturing' && <button className="primary stop" data-autofocus disabled={busy} onClick={() => void stop()}><Icon name="stop" size={15} />{busy ? 'Stopping…' : 'Stop capture'}</button>}
      {phase === 'ended' && <><button className="secondary" onClick={onClose}>Close</button><button className="primary" data-autofocus onClick={onAddNotes}>Add notes</button></>}
    </div>
  </Modal>;
}
