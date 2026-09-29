import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Modal } from './Dialogs';
import { clock, type Meeting } from './model';
import * as storage from './storage';
const mac = /Mac/.test(navigator.userAgent);
const device = mac ? 'Mac' : 'PC';
const settingsName = mac ? 'System Settings' : 'Settings';
type Props = { meeting: Meeting; autoStart: boolean; live: storage.CaptureState; onUpdated: (meeting: Meeting) => void; onClose: () => void; onAddNotes: () => void };
export function Capture(props: Props) { return props.live.available ? <Recorder {...props} /> : <Prototype {...props} />; }
function useAutoStart(autoStart: boolean, start: () => Promise<void>) {
  const started = useRef(false);
  useEffect(() => { if (autoStart && !started.current) { started.current = true; void start(); } }, []);
}
// Keep focus on the one primary control as it changes between Start, Stop and Add notes.
function useFocusPrimary(...deps: unknown[]) { useEffect(() => { document.querySelector<HTMLElement>('.modal.capture [data-autofocus]')?.focus(); }, deps); }
function Status({ phase, elapsed, facts }: { phase: 'ready' | 'capturing' | 'ended'; elapsed: number; facts: string }) {
  return <div key={phase} className={`capture-status ${phase}`} role="status">
    <span className="capture-state">{phase === 'capturing' ? <><i className="live-dot" aria-hidden="true" />Recording</> : phase === 'ended' ? 'Recording ended' : 'Not recording'}</span>
    <strong aria-label={`Elapsed time ${clock(elapsed)}`}>{clock(elapsed)}</strong>
    <span className="capture-facts">{facts}</span>
  </div>;
}
const track = (name: string, level: storage.Level) => level === 'heard' ? `${name} ✓` : `${name}: ${level === 'silent' ? 'silent' : 'no sound yet'}`;
/** What QuietNote will ask for and why, shown before the first OS permission prompt. */
function FirstRun() {
  return <div className="capture-explainer">
    <strong>Before your first recording</strong>
    <p>When you press Start recording, macOS asks for two permissions:</p>
    <ul>
      <li><b>Microphone</b>, to record your side of the meeting.</li>
      <li><b>System audio recording</b>, to record what the others say, from your Mac’s sound output.</li>
    </ul>
    <p>QuietNote doesn’t join the call or add a bot. Nothing records until you press Start, and the audio is transcribed on this Mac.</p>
  </div>;
}
function Alert({ title, children, action }: { title: string; children: string; action?: [string, () => void] }) {
  return <div className="capture-alert" role="alert"><strong>{title}</strong><p>{children}</p>{action && <button className="text-button" onClick={action[1]}>{action[0]}</button>}</div>;
}
/** Real capture: Rust records the mic and system audio, then transcribes on this device. */
function Recorder({ meeting, autoStart, live, onUpdated, onClose, onAddNotes }: Props) {
  const { id, status, duration } = meeting.metadata;
  const [failure, setFailure] = useState<storage.CaptureFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const recording = live.recording?.meetingId === id ? live.recording : null;
  const other = live.recording && !recording ? live.recording : null;
  const phase = recording || status === 'recording' ? 'capturing' : status === 'idle' ? 'ready' : 'ended';
  const firstRun = live.microphone === 'undetermined';
  const denied = phase === 'ready' && (failure?.code === 'mic-denied' || live.microphone === 'denied');
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [recording]);
  const elapsed = recording ? (now - Date.parse(recording.startedAt)) / 1000 : duration;
  async function start() {
    setBusy(true); setFailure(null);
    try { onUpdated({ ...meeting, metadata: await storage.captureStart(id) }); }
    catch (e) { setFailure(e as storage.CaptureFailure); }
    finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true); setFailure(null);
    try { onUpdated({ ...meeting, metadata: await storage.captureStop() }); }
    catch (e) { setFailure({ code: 'failed', message: `Couldn’t stop recording. ${String(e)}` }); }
    finally { setBusy(false); }
  }
  const settings = (kind: 'microphone' | 'systemAudio'): [string, () => void] => [`Open ${settingsName}`, () => void storage.openPrivacySettings(kind).catch(() => { /* The message says where to go. */ })];
  // The first recording waits for Start, so the explanation comes before macOS asks.
  useAutoStart(autoStart && !firstRun && !denied, start);
  useFocusPrimary(phase, busy, denied);
  const job = live.transcribing?.meetingId === id ? live.transcribing : null;
  const facts = phase === 'ready' ? `Records your microphone and the call audio on this ${device}. Nothing joins the call.`
    : recording ? 'Started by you · No bot joined'
    : status === 'processing' ? (job ? `Transcribing on this ${device}… ${job.percent}%` : 'Waiting to transcribe…')
    : status === 'ready' ? 'Transcript ready. Add your notes while the meeting is fresh.'
    : 'The transcript couldn’t be made. The audio is kept, so you can try again.';
  return <Modal className="capture" title={meeting.metadata.title} onEscape={busy ? undefined : onClose}>
    <p className="capture-project"><Icon name="folder" size={14} />{meeting.metadata.project}</p>
    {phase === 'ready' && firstRun && mac && !failure ? <FirstRun /> : <Status phase={phase} elapsed={elapsed} facts={facts} />}
    {recording && <p className="capture-tracks" title={[recording.micDevice, recording.systemDevice].filter(Boolean).join(' · ')}>{track('Mic', recording.mic)} · {track('Call audio', recording.system)}</p>}
    {recording?.problem && <Alert title="Needs attention">{recording.problem}</Alert>}
    {recording && !recording.problem && recording.mic === 'silent' && <Alert title="Your microphone is silent" action={settings('microphone')}>{`No sound has come from ${recording.micDevice ?? 'the microphone'}. Check that it isn’t muted, and that QuietNote is allowed to use it.`}</Alert>}
    {recording && recording.system === 'silent' && <Alert title="No call audio yet" action={mac ? settings('systemAudio') : undefined}>{mac ? 'If others are talking, allow QuietNote under Screen & System Audio Recording. If you just allowed it, stop and start recording again.' : 'If others are talking, check that the call plays through your default speakers or headset.'}</Alert>}
    {recording?.note && <p className="capture-note">{recording.note}</p>}
    {phase === 'capturing' && <p className="capture-note">Recording continues in the {mac ? 'menu bar' : 'system tray'} if you close this.</p>}
    {phase === 'ready' && live.model !== 'ready' && <Alert title="Transcription is unavailable">{`The speech model is ${live.model} in this installation. You can still record; the audio is kept for when transcription works.`}</Alert>}
    {phase === 'ready' && other && <Alert title="Another meeting is recording">{`“${other.title}” is recording. Stop it first.`}</Alert>}
    {denied ? <Alert title="Microphone access is off" action={settings('microphone')}>{failure?.message ?? `QuietNote can’t use the microphone. Allow it in ${settingsName}, then try again.`}</Alert>
      : failure && <Alert title={failure.code === 'disk' ? 'Not enough disk space' : 'Recording didn’t start'}>{failure.message}</Alert>}
    <div className="modal-actions">
      {phase === 'ready' && <><button className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" data-autofocus disabled={busy || Boolean(other)} onClick={() => void start()}>{busy ? (firstRun ? 'Waiting for permission…' : 'Starting…') : denied || failure ? 'Try again' : 'Start recording'}</button></>}
      {phase === 'capturing' && <><button className="secondary" disabled={busy} onClick={onClose}>Hide</button><button className="primary stop" data-autofocus disabled={busy} onClick={() => void stop()}><Icon name="stop" size={15} />{busy ? 'Stopping…' : 'Stop recording'}</button></>}
      {phase === 'ended' && <><button className="secondary" onClick={onClose}>Close</button><button className="primary" data-autofocus onClick={onAddNotes}>Add notes</button></>}
    </div>
  </Modal>;
}
/** The browser preview (and platforms without recording) track a session but record no audio. */
function Prototype({ meeting, autoStart, onUpdated, onClose, onAddNotes }: Props) {
  const [record, setRecord] = useState(meeting);
  const [phase, setPhase] = useState<'ready' | 'capturing' | 'ended'>('ready');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(0);
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
  useAutoStart(autoStart, start);
  useFocusPrimary(phase, busy);
  return <Modal className="capture" title={record.metadata.title} onEscape={capturing || busy ? undefined : onClose}>
    <p className="capture-project"><Icon name="folder" size={14} />{record.metadata.project}</p>
    <p className="prototype-line"><span className="badge">Prototype</span>{storage.desktop ? 'Recording isn’t available on this platform yet.' : 'Recording needs the desktop app.'}</p>
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
