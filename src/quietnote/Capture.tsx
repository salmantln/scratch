import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Icon } from './Icon';
import { clock, recorded, stopsIn, type Meeting } from './model';
import * as storage from './storage';
const mac = /Mac/.test(navigator.userAgent);
const device = mac ? 'Mac' : 'PC';
const settingsName = mac ? 'System Settings' : 'Settings';
const consent = 'Let everyone know you’re recording.';
/** A message to paste into the meeting chat. It claims only what's true of every recording. */
export const consentMessage = 'Heads up: I’m recording this call for my notes. It’s transcribed on my computer, and no bot joins the call.';
/** Copies the consent message, to paste into the call's chat; QuietNote never types into the call app itself. */
function CopyConsent() {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { if (storage.desktop) await writeText(consentMessage); else await navigator.clipboard.writeText(consentMessage); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { setCopied(false); }
  }
  return <button className="text-button" title={consentMessage} onClick={() => void copy()}><Icon name="copy" size={14} />{copied ? 'Copied' : 'Copy message'}</button>;
}
/** `transcript`: whether the recorder shows the live transcript (not while the Transcript tab shows it already). */
type Props = { meeting: Meeting; autoStart: boolean; live: storage.CaptureState; clean: boolean; transcript: boolean; onUpdated: (meeting: Meeting) => void; onClose: () => void };
/** The recorder is pinned to the bottom of the meeting, so notes and the transcript stay usable above it while it runs. */
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
export const track = (name: string, level: storage.Level, waiting = 'no sound yet') => level === 'heard' ? `${name} ✓` : `${name}: ${level === 'silent' ? 'silent' : waiting}`;
/** Call audio is only what the others say, so until someone else speaks it's waiting, not failing. */
export const othersWaiting = 'waiting for others';
/** Five bars from a peak sample (0–1), about 9 dB each from −50 dB. */
const bars = (peak: number) => peak <= 0 ? 0 : Math.max(0, Math.min(5, Math.ceil((20 * Math.log10(peak) + 50) / 9)));
const Bars = ({ peak }: { peak: number }) => { const lit = bars(peak); return <span className="meter-bars" aria-hidden="true">{[0, 1, 2, 3, 4].map(i => <i key={i} className={i < lit ? 'on' : undefined} />)}</span>; };
function Meter({ name, peak, level, waiting, source }: { name: string; peak: number; level: storage.Level; waiting: string; source: string | null }) {
  return <span className="meter"><span className="meter-name">{name}</span><Bars peak={peak} />
    {level === 'heard' ? <><span className="sr-only">✓</span>{source && <span className="meter-source">{source}</span>}</> : <span>{level === 'silent' ? 'silent' : waiting}</span>}</span>;
}
/** Live levels from Rust (`quietnote://levels`, ten a second), so it's clear at once that both tracks are recording. */
function useLevels(running: boolean): [number, number] {
  const [levels, setLevels] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    setLevels([0, 0]);
    if (!storage.desktop || !running) return;
    let cancelled = false; let unlisten: (() => void) | undefined;
    listen<[number, number]>('quietnote://levels', e => setLevels(e.payload)).then(fn => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, [running]);
  return levels;
}
/** Whether each track was loud enough to be speech in the last moment, for the "listening" dots of the live transcript. */
function useSpeaking([mic, system]: [number, number], now: number): [boolean, boolean] {
  const heard = useRef<[number, number]>([0, 0]);
  if (mic > 0.02) heard.current[0] = Date.now();
  if (system > 0.02) heard.current[1] = Date.now();
  return [now - heard.current[0] < 1500, now - heard.current[1] < 1500];
}
const liveEmpty: Record<storage.LiveText, string> = {
  off: '', loading: 'Starting the live transcript…', on: 'Words appear here a few seconds after they’re spoken.',
  failed: 'The live transcript couldn’t start. The full transcript is still made when you stop.',
};
/** The live transcript: real words from this device's speech model, shown as a draft while recording and
 * until the full transcript replaces it. It follows the latest words unless you scroll back. `listening`
 * shows dots for a side that's talking before its words arrive; no words are ever made up for it. */
export function LiveTranscript({ meetingId, clean, state, listening, empty, caption }: { meetingId: string; clean: boolean; state: storage.LiveText; listening?: [boolean, boolean]; empty?: ReactNode; caption?: string }) {
  const [turns, setTurns] = useState<storage.TranscriptTurn[]>([]);
  const [latest, setLatest] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!storage.desktop) return;
    let cancelled = false; let unlisten: (() => void) | undefined;
    storage.liveTranscript().then(d => { if (!cancelled && d?.meetingId === meetingId) setTurns(d.turns); }).catch(() => { /* The next update brings it. */ });
    listen<storage.Draft>('quietnote://live-transcript', e => { if (e.payload.meetingId === meetingId) setTurns(e.payload.turns); }).then(fn => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, [meetingId]);
  const shown = turns.map(t => ({ speaker: t.speaker, words: clean ? t.clean : t.text })).filter(t => t.words.trim());
  // Sides are told apart by where the bubble sits; the name only comes in once both have spoken.
  const voices = new Set(shown.map(t => t.speaker)).size;
  const dots = (listening ?? [false, false]).map((on, i) => on && state === 'on' ? i : -1).filter(i => i >= 0);
  useLayoutEffect(() => { if (latest && list.current) list.current.scrollTop = list.current.scrollHeight; }, [shown.length, turns, dots.length, latest]);
  if (!shown.length && empty !== undefined) return <>{empty}</>;
  return <div className="live-transcript">
    {caption && <p className="subtle transcript-caption">{caption}</p>}
    <div className="live-turns" ref={list} role="log" aria-label="Live transcript" onScroll={e => { const el = e.currentTarget; setLatest(el.scrollHeight - el.scrollTop - el.clientHeight < 24); }}>
      {shown.map((t, i) => <p key={i} className={`live-turn ${t.speaker === 'You' ? 'you' : 'others'}`}>{voices > 1 && t.speaker !== shown[i - 1]?.speaker && <span className="live-speaker">{t.speaker}</span>}{t.words}</p>)}
      {dots.map(i => <p key={`dots-${i}`} className={`live-turn listening ${i === 0 ? 'you' : 'others'}`} aria-hidden="true"><i /><i /><i /></p>)}
      {!shown.length && !dots.length && <p className="subtle">{liveEmpty[state]}</p>}
    </div>
    {!latest && <button className="text-button live-latest" onClick={() => setLatest(true)}>Jump to latest</button>}
  </div>;
}
/** Whether the recorder's details are shown; remembered in this window only, and shown when unknown. */
const drawerKey = 'quietnote.drawer.v1';
function useDrawer(): [boolean, () => void] {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(drawerKey) !== 'closed'; } catch { return true; } });
  return [open, () => setOpen(o => { try { localStorage.setItem(drawerKey, o ? 'closed' : 'open'); } catch { /* Only a convenience. */ } return !o; })];
}
/** Chooses the microphone; a recording in progress switches at once, and later ones keep the choice. */
function MicPicker({ current }: { current: string | null }) {
  const [choice, setChoice] = useState<storage.Devices | null>(null);
  const [error, setError] = useState('');
  // Devices come and go (AirPods connecting), and the recorder notices first.
  useEffect(() => { storage.captureDevices().then(setChoice).catch(() => setChoice(null)); }, [current]);
  if (!choice?.devices.length) return null;
  const { devices, selected } = choice;
  return <label className="mic-picker" title={error || 'Microphone'}><Icon name="mic" size={15} /><span className="sr-only">Microphone</span>
    <select value={selected ?? ''} onChange={e => {
      const name = e.target.value || null;
      setChoice({ devices, selected: name }); setError('');
      storage.setCaptureDevice(name).catch(err => setError(`Couldn’t switch the microphone. ${String(err)}`));
    }}>
      <option value="">System default{!selected && current ? ` (${current})` : ''}</option>
      {devices.map(d => <option key={d} value={d}>{d}</option>)}
      {selected && !devices.includes(selected) && <option value={selected}>{selected} (not connected)</option>}
    </select></label>;
}
/** What QuietNote will ask for and why, shown before the first OS permission prompt. */
function FirstRun() {
  return <div className="capture-explainer">
    <strong>Before your first recording</strong>
    <p>When you press Start recording, macOS asks for two permissions:</p>
    <ul>
      <li><b>Microphone</b>, to record your side of the meeting.</li>
      <li><b>System audio recording</b>, to record what the others say, from your Mac’s sound output.</li>
    </ul>
    <p>QuietNote doesn’t join the call or add a bot. Nothing records until you press Start, and the audio is transcribed on this Mac. {consent}</p>
  </div>;
}
function Alert({ title, children, action }: { title: string; children: string; action?: [string, () => void] }) {
  return <div className="capture-alert" role="alert"><strong>{title}</strong> <span>{children}</span>{action && <button className="text-button" onClick={action[1]}>{action[0]}</button>}</div>;
}
/** The bar at the bottom of a recording meeting: one line with the state, the time and the controls. Details open
 * above it, and anything that needs attention sits between the two. */
function Dock({ label, paused, elapsed, lead, detail, actions, drawer, children }: { label: string; paused?: boolean; elapsed?: number; lead?: ReactNode; detail?: ReactNode; actions?: ReactNode; drawer?: ReactNode; children?: ReactNode }) {
  return <section className={`recorder-dock ${paused ? 'paused' : ''}`} aria-label="Recorder">
    {drawer}
    {children}
    <div className="recorder-line">
      {lead}
      <span className="recorder-state" role="status"><i className={paused ? 'paused-dot' : 'live-dot'} aria-hidden="true" />{label}</span>
      {elapsed !== undefined && <strong className="recorder-time" aria-label={`Recorded time ${clock(elapsed)}`}>{clock(elapsed)}</strong>}
      {typeof detail === 'string' ? <span className="recorder-detail">{detail}</span> : detail}
      {actions && <span className="recorder-buttons">{actions}</span>}
    </div>
  </section>;
}
/** Shown only when a start is held back: the first-run explanation, a permission or start problem. */
function StartCard({ children, busy, label, disabled, onStart, onCancel }: { children: ReactNode; busy: boolean; label: string; disabled?: boolean; onStart: () => void; onCancel: () => void }) {
  return <section className="recorder-dock expanded" aria-label="Recorder">
    {children}
    <div className="recorder-actions"><button className="secondary" disabled={busy} onClick={onCancel}>Cancel</button><button className="primary" disabled={busy || disabled} onClick={onStart}>{label}</button></div>
  </section>;
}
/** Real capture: Rust records the mic and system audio, then transcribes on this device. */
function Recorder({ meeting, autoStart, live, clean, transcript, onUpdated, onClose }: Props) {
  const { id, status } = meeting.metadata;
  const [failure, setFailure] = useState<(storage.CaptureFailure & { title: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, toggle] = useDrawer();
  const drawerId = useId();
  const recording = live.recording?.meetingId === id ? live.recording : null;
  const other = live.recording && !recording ? live.recording : null;
  const capturing = Boolean(recording) || status === 'recording';
  const paused = recording?.resumedAt === null;
  const firstRun = live.microphone === 'undetermined';
  const denied = !capturing && (failure?.code === 'mic-denied' || live.microphone === 'denied');
  const now = useNow(Boolean(recording) && !paused);
  const [mic, system] = useLevels(Boolean(recording) && !paused);
  const speaking = useSpeaking([mic, system], now);
  const liveText = recording?.liveText ?? 'off';
  async function run(action: () => Promise<void>, title: string) {
    setBusy(true); setFailure(null);
    try { await action(); }
    catch (e) { setFailure({ ...(typeof e === 'object' && e && 'code' in e ? e as storage.CaptureFailure : { code: 'failed', message: String(e) }), title }); }
    finally { setBusy(false); }
  }
  const start = () => run(async () => onUpdated({ ...meeting, metadata: await storage.captureStart(id) }), 'Recording didn’t start.');
  const stop = () => run(async () => onUpdated({ ...meeting, metadata: await storage.captureStop() }), 'Recording didn’t stop.');
  const settings = (kind: 'microphone' | 'systemAudio'): [string, () => void] => [`Open ${settingsName}`, () => void storage.openPrivacySettings(kind).catch(() => { /* The message says where to go. */ })];
  // The first recording waits for Start, so the explanation comes before macOS asks.
  const auto = autoStart && (status === 'idle' || status === 'ready') && !firstRun && !denied && !other;
  useAutoStart(auto, start);
  if (capturing) {
    return <Dock label={paused ? 'Paused' : 'Recording'} paused={paused} elapsed={recording ? recorded(recording, now) : undefined}
      lead={recording && <button className="level-button" aria-expanded={open} aria-controls={drawerId} title={open ? 'Hide details' : 'Show details'} onClick={toggle}>
        <Bars peak={Math.max(mic, system)} /><Icon name="chevron" size={14} style={open ? undefined : { transform: 'rotate(180deg)' }} /><span className="sr-only">Recording details</span></button>}
      detail={recording && <MicPicker current={recording.micDevice} />}
      // Pause and Resume share a place and Stop keeps its own, so switching never moves a button under the pointer.
      actions={recording && <>
        {paused ? <button className="primary" disabled={busy} onClick={() => void run(storage.captureResume, 'Recording didn’t resume.')}><Icon name="play" size={13} />Resume</button>
          : <button className="secondary" disabled={busy} onClick={() => void run(storage.capturePause, 'Recording didn’t pause.')}><Icon name="pause" size={14} />Pause</button>}
        <button className={`${paused ? 'secondary' : 'primary'} stop`} aria-label="Stop recording" title="Stop recording" disabled={busy} onClick={() => void stop()}><Icon name="stop" size={14} />{busy && !paused ? 'Stopping…' : 'Stop'}</button>
      </>}
      drawer={recording && open && <div className="recorder-drawer" id={drawerId}>
        <div className="recorder-drawer-head"><p className="recorder-consent"><Icon name="info" size={14} />{consent}<CopyConsent /></p>
          <p className="subtle">{liveText === 'on' ? `Live draft · the full transcript is made when you stop` : `Transcribed on this ${device} when you stop`}</p></div>
        {transcript && liveText !== 'off' && <LiveTranscript meetingId={id} clean={clean} state={liveText} listening={paused ? undefined : speaking} />}
        {paused ? <p className="subtle">Paused. The microphone and call audio aren’t being recorded until you resume.</p>
        : <div className="recorder-meters"><Meter name="Mic" peak={mic} level={recording.mic} waiting="no sound yet" source={recording.micDevice} /><Meter name="Call audio" peak={system} level={recording.system} waiting={othersWaiting} source={recording.systemDevice} /></div>}
      </div>}>
      {recording?.ending && <Alert title={recording.ending.reason} action={['Keep recording', () => void run(storage.captureKeep, 'Couldn’t keep recording.')]}>{stopsIn(recording.ending.stopsAt, now)}</Alert>}
      {recording?.problem && <Alert title="Needs attention.">{recording.problem}</Alert>}
      {recording && !paused && !recording.problem && recording.mic === 'silent' && <Alert title="Your microphone is silent." action={settings('microphone')}>{`No sound has come from ${recording.micDevice ?? 'the microphone'}. Check that it isn’t muted, and that QuietNote is allowed to use it.`}</Alert>}
      {recording && !paused && recording.system === 'silent' && <Alert title="No call audio yet." action={mac ? settings('systemAudio') : undefined}>{mac ? 'If others are talking, allow QuietNote under Screen & System Audio Recording. If you just allowed it, stop and start recording again.' : 'If others are talking, check that the call plays through your default speakers or headset.'}</Alert>}
      {recording?.note && <p className="recorder-note">{recording.note}</p>}
      {failure && <Alert title={failure.code === 'disk' ? 'Not enough disk space.' : failure.code === 'mic-denied' ? 'Microphone access is off.' : failure.title} action={failure.code === 'mic-denied' ? settings('microphone') : undefined}>{failure.message}</Alert>}
    </Dock>;
  }
  if (!firstRun && (busy || (auto && !failure))) return <Dock label="Starting…" />;
  return <StartCard busy={busy} disabled={Boolean(other)} onStart={() => void start()} onCancel={onClose} label={busy ? 'Waiting for permission…' : denied || failure ? 'Try again' : 'Start recording'}>
    {firstRun && mac && !failure ? <FirstRun /> : <p className="recorder-intro">Records your microphone and the call audio on this {device}. Nothing joins the call. {consent}</p>}
    {live.model !== 'ready' && <Alert title="Transcription is unavailable.">{`The speech model is ${live.model} in this installation. You can still record; the audio is kept for when transcription works.`}</Alert>}
    {other && <Alert title="Another meeting is recording.">{`“${other.title}” is recording. Stop it first.`}</Alert>}
    {denied ? <Alert title="Microphone access is off." action={settings('microphone')}>{failure?.message ?? `QuietNote can’t use the microphone. Allow it in ${settingsName}, then try again.`}</Alert>
      : failure && <Alert title={failure.code === 'disk' ? 'Not enough disk space.' : failure.title}>{failure.message}</Alert>}
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
  if (capturing) return <Dock label="Capturing" elapsed={elapsed} detail={`${prototype}. No audio is recorded.`}
    actions={<button className="primary stop" disabled={busy} onClick={() => void stop()}><Icon name="stop" size={14} />{busy ? 'Stopping…' : 'Stop capture'}</button>}>
    {error && <Alert title="Capture didn’t stop.">{error}</Alert>}
  </Dock>;
  if (busy || !error) return <Dock label="Starting…" />;
  return <StartCard busy={busy} onStart={() => void start()} onCancel={onClose} label="Try again">
    <p className="recorder-intro">{prototype}.</p>
    <Alert title="Capture didn’t start.">{error}</Alert>
  </StartCard>;
}
