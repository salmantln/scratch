import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { clock, type Meeting } from './model';
import * as storage from './storage';
const mac = /Mac/.test(navigator.userAgent);
const device = mac ? 'Mac' : 'PC';
const settingsName = mac ? 'System Settings' : 'Settings';
type Props = { meeting: Meeting; autoStart: boolean; live: storage.CaptureState; onUpdated: (meeting: Meeting) => void; onClose: () => void };
/** The recorder sits inside the meeting, under the tabs, so notes and the transcript stay usable while it runs. */
export function Capture(props: Props) { return props.live.available ? <Recorder {...props} /> : <Prototype {...props} />; }
function useAutoStart(autoStart: boolean, start: () => Promise<void>) {
  const started = useRef(false);
  useEffect(() => { if (autoStart && !started.current) { started.current = true; void start(); } }, []);
}
function useNow(running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}
export const track = (name: string, level: storage.Level) => level === 'heard' ? `${name} ✓` : `${name}: ${level === 'silent' ? 'silent' : 'no sound yet'}`;
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
  return <div className="capture-alert" role="alert"><strong>{title}</strong> <span>{children}</span>{action && <button className="text-button" onClick={action[1]}>{action[0]}</button>}</div>;
}
/** One line while recording: state, elapsed time, what's being heard, Stop. Anything that needs attention goes below it. */
function Strip({ label, elapsed, detail, detailTitle, action, children }: { label: string; elapsed?: number; detail?: string; detailTitle?: string; action?: ReactNode; children?: ReactNode }) {
  return <section className="recorder-strip" aria-label="Recorder">
    <div className="recorder-line">
      <span className="recorder-state" role="status"><i className="live-dot" aria-hidden="true" />{label}</span>
      {elapsed !== undefined && <strong className="recorder-time" aria-label={`Elapsed time ${clock(elapsed)}`}>{clock(elapsed)}</strong>}
      {detail && <span className="recorder-detail" title={detailTitle}>{detail}</span>}
      {action}
    </div>
    {children}
  </section>;
}
/** Shown only when a start is held back: the first-run explanation, a permission or start problem. */
function StartCard({ children, busy, label, disabled, onStart, onCancel }: { children: ReactNode; busy: boolean; label: string; disabled?: boolean; onStart: () => void; onCancel: () => void }) {
  return <section className="recorder-strip expanded" aria-label="Recorder">
    {children}
    <div className="recorder-actions"><button className="secondary" disabled={busy} onClick={onCancel}>Cancel</button><button className="primary" disabled={busy || disabled} onClick={onStart}>{label}</button></div>
  </section>;
}
/** Real capture: Rust records the mic and system audio, then transcribes on this device. */
function Recorder({ meeting, autoStart, live, onUpdated, onClose }: Props) {
  const { id, status } = meeting.metadata;
  const [failure, setFailure] = useState<storage.CaptureFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const recording = live.recording?.meetingId === id ? live.recording : null;
  const other = live.recording && !recording ? live.recording : null;
  const capturing = Boolean(recording) || status === 'recording';
  const firstRun = live.microphone === 'undetermined';
  const denied = !capturing && (failure?.code === 'mic-denied' || live.microphone === 'denied');
  const now = useNow(Boolean(recording));
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
  const auto = autoStart && status === 'idle' && !firstRun && !denied && !other;
  useAutoStart(auto, start);
  if (capturing) return <Strip label="Recording" elapsed={recording ? (now - Date.parse(recording.startedAt)) / 1000 : undefined}
    detail={recording ? `${track('Mic', recording.mic)} · ${track('Call audio', recording.system)}` : undefined} detailTitle={recording ? [recording.micDevice, recording.systemDevice].filter(Boolean).join(' · ') : undefined}
    action={<button className="primary stop" disabled={busy} onClick={() => void stop()}><Icon name="stop" size={14} />{busy ? 'Stopping…' : 'Stop recording'}</button>}>
    {recording?.problem && <Alert title="Needs attention.">{recording.problem}</Alert>}
    {recording && !recording.problem && recording.mic === 'silent' && <Alert title="Your microphone is silent." action={settings('microphone')}>{`No sound has come from ${recording.micDevice ?? 'the microphone'}. Check that it isn’t muted, and that QuietNote is allowed to use it.`}</Alert>}
    {recording && recording.system === 'silent' && <Alert title="No call audio yet." action={mac ? settings('systemAudio') : undefined}>{mac ? 'If others are talking, allow QuietNote under Screen & System Audio Recording. If you just allowed it, stop and start recording again.' : 'If others are talking, check that the call plays through your default speakers or headset.'}</Alert>}
    {recording?.note && <p className="recorder-note">{recording.note}</p>}
    {failure && <Alert title="Recording didn’t stop.">{failure.message}</Alert>}
  </Strip>;
  if (!firstRun && (busy || (auto && !failure))) return <Strip label="Starting…" />;
  return <StartCard busy={busy} disabled={Boolean(other)} onStart={() => void start()} onCancel={onClose} label={busy ? 'Waiting for permission…' : denied || failure ? 'Try again' : 'Start recording'}>
    {firstRun && mac && !failure ? <FirstRun /> : <p className="recorder-intro">Records your microphone and the call audio on this {device}. Nothing joins the call.</p>}
    {live.model !== 'ready' && <Alert title="Transcription is unavailable.">{`The speech model is ${live.model} in this installation. You can still record; the audio is kept for when transcription works.`}</Alert>}
    {other && <Alert title="Another meeting is recording.">{`“${other.title}” is recording. Stop it first.`}</Alert>}
    {denied ? <Alert title="Microphone access is off." action={settings('microphone')}>{failure?.message ?? `QuietNote can’t use the microphone. Allow it in ${settingsName}, then try again.`}</Alert>
      : failure && <Alert title={failure.code === 'disk' ? 'Not enough disk space.' : 'Recording didn’t start.'}>{failure.message}</Alert>}
  </StartCard>;
}
/** The browser preview (and platforms without recording) track a session but record no audio. */
function Prototype({ meeting, autoStart, onUpdated, onClose }: Props) {
  const { status, captureStartedAt } = meeting.metadata;
  const capturing = status === 'recording';
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const now = useNow(capturing);
  const elapsed = Math.max(0, Math.floor((now - Date.parse(captureStartedAt ?? new Date(now).toISOString())) / 1000));
  useEffect(() => {
    if (!capturing) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [capturing]);
  async function save(next: Meeting) { await storage.saveMetadata(next.metadata); onUpdated(next); }
  async function start() {
    setBusy(true); setError('');
    try { await save({ ...meeting, metadata: { ...meeting.metadata, status: 'recording', captureStartedAt: new Date().toISOString() } }); }
    catch (e) { setError(`Couldn’t start capture. ${String(e)}`); }
    finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true); setError('');
    try { await save({ ...meeting, metadata: { ...meeting.metadata, status: 'ready', duration: elapsed, captureEndedAt: new Date().toISOString() } }); onClose(); }
    catch (e) { setError(`Couldn’t save the end of capture. Try again. ${String(e)}`); setBusy(false); }
  }
  useAutoStart(autoStart && !capturing, start);
  const prototype = storage.desktop ? 'Prototype: recording isn’t available on this platform yet' : 'Prototype: recording needs the desktop app';
  if (capturing) return <Strip label="Capturing" elapsed={elapsed} detail={`${prototype}. No audio is recorded.`}
    action={<button className="primary stop" disabled={busy} onClick={() => void stop()}><Icon name="stop" size={14} />{busy ? 'Stopping…' : 'Stop capture'}</button>}>
    {error && <Alert title="Capture didn’t stop.">{error}</Alert>}
  </Strip>;
  if (busy || !error) return <Strip label="Starting…" />;
  return <StartCard busy={busy} onStart={() => void start()} onCancel={onClose} label="Try again">
    <p className="recorder-intro">{prototype}.</p>
    <Alert title="Capture didn’t start.">{error}</Alert>
  </StartCard>;
}
