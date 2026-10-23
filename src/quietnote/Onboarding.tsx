import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Folder, Icon, Logo } from './Icon';
import { Hush, useHushShown } from './Hush';
import { validProjectName } from './model';
import * as storage from './storage';

type Step = 'hello' | 'how' | 'microphone' | 'calendar' | 'kind' | 'project';
/** The kinds of meeting to choose from: each picks its built-in note template and names the first project. */
const kinds: { template: string; label: string; project: string; headings: string }[] = [
  { template: '1:1', label: '1:1s', project: 'One-on-ones', headings: 'Updates · Feedback · Blockers · Next steps' },
  { template: 'Standup', label: 'Standups', project: 'Team', headings: 'Progress · Next · Blockers' },
  { template: 'Sales call', label: 'Sales calls', project: 'Sales', headings: 'Context · Needs · Questions and objections · Next steps' },
  { template: 'User interview', label: 'User interviews', project: 'Research', headings: 'About them · What they said · Feedback · Follow-ups' },
  { template: 'Project kickoff', label: 'Project kickoffs', project: 'Projects', headings: 'Goals · Scope and timeline · Roles · Risks · Next steps' },
  { template: 'General', label: 'A bit of everything', project: 'Work', headings: 'Overview · Discussion · Next steps' },
];
const mac = storage.device === 'Mac';
/** Illustrations only: shapes and the app's own labels, never words anyone said. */
function CallScene() {
  return <div className="ob-scene ob-call" aria-hidden="true">
    <div className="ob-window"><span /><span /><span /><span /></div>
    <div className="ob-notes"><Logo size={14} /><i /><i /><i /><i /></div>
  </div>;
}
function TracksScene() {
  const bars = (n: number) => Array.from({ length: n }, (_, i) => <i key={i} style={{ height: `${30 + (i * 37) % 65}%`, animationDelay: `${(i * 137) % 900}ms` }} />);
  return <div className="ob-scene ob-tracks" aria-hidden="true">
    <div className="ob-track"><span>You</span><b>{bars(14)}</b></div>
    <div className="ob-track others"><span>Others</span><b>{bars(14)}</b></div>
    <div className="ob-device"><Icon name="check" size={14} />On this {storage.device}</div>
  </div>;
}
function Badge({ icon }: { icon: 'mic' | 'meeting' }) {
  return <div className="ob-scene" aria-hidden="true"><span className="ob-badge"><Icon name={icon} size={30} /></span></div>;
}
type Props = {
  live: storage.CaptureState; preferences: storage.PrivacyPreferences; busy: boolean;
  onPreference: (key: string, value: storage.PrivacyPreferences[string]) => void; onCreate: (project: string) => Promise<void>; onExamples: () => void;
};
/** First launch: what QuietNote does, one screen at a time; each permission explained before macOS asks for it;
 * one question, which can be skipped; then the first project. Nothing records here. */
export function Onboarding({ live, preferences, busy, onPreference, onCreate, onExamples }: Props) {
  const hush = useHushShown();
  // Fixed when it opens, so a permission granted along the way doesn't remove the step you're on.
  const [steps] = useState<Step[]>(() => [
    'hello',
    ...(live.available ? ['how' as const] : []),
    ...(live.available && mac && (live.microphone === 'undetermined' || live.microphone === 'denied') ? ['microphone' as const] : []),
    ...(storage.desktop && mac && preferences.calendar !== true ? ['calendar' as const] : []),
    'kind', 'project',
  ]);
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [kind, setKind] = useState(() => typeof preferences.noteTemplate === 'string' ? preferences.noteTemplate : '');
  // Untouched, the name follows the kind of meeting chosen.
  const [mic, setMic] = useState(live.microphone);
  const [calendar, setCalendar] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  const fieldId = useId();
  const step = steps[index];
  const chosen = kinds.find(k => k.template === kind);
  const [typed, setName] = useState<string | null>(null);
  const name = typed ?? chosen?.project ?? 'Work';
  // Each new step is announced from its heading, as a page would be.
  useEffect(() => { if (moved.current) heading.current?.focus(); }, [index]);
  const go = (by: 1 | -1) => { moved.current = true; setDirection(by > 0 ? 'forward' : 'back'); setError(''); setIndex(i => Math.min(steps.length - 1, Math.max(0, i + by))); };
  const settings = (pane: 'microphone' | 'calendars') => () => void storage.openPrivacySettings(pane).catch(() => { /* The message says where to go. */ });
  async function allowMicrophone() {
    setWorking(true);
    try { const state = await storage.allowMicrophone(); setMic(state.microphone); if (state.microphone === 'granted') go(1); }
    catch (e) { setError(`Couldn’t ask for the microphone. ${String(e)}`); }
    finally { setWorking(false); }
  }
  async function useCalendar() {
    setWorking(true); onPreference('calendar', true);
    try { const access = await storage.calendarAccess(true); setCalendar(access); if (access === 'granted') go(1); }
    catch { setCalendar('denied'); }
    finally { setWorking(false); }
  }
  async function create() {
    const project = name.trim();
    const problem = validProjectName(project);
    if (problem) { setError(problem); return; }
    setWorking(true);
    try { await onCreate(project); }
    catch (e) { setError(String(e).replace(/^Error: /, '')); setWorking(false); }
  }
  let scene: ReactNode = null, extra: ReactNode = null, title: string, body: ReactNode, action: ReactNode;
  if (step === 'hello') {
    scene = <CallScene />; title = 'Keep the useful part of every meeting.';
    body = <><p>{live.available ? `QuietNote records and transcribes your meetings on this ${storage.device}. No bot joins the call, and nothing records until you press Start.` : 'Notes and action items for your meetings, organized by project and kept on your device.'}</p>
      {hush && <p className="ob-hush"><Hush mood="ready" size={40} />This is Hush. Its face shows what QuietNote is doing.</p>}
      {!storage.desktop && <p className="subtle">Browser preview · meetings are saved in this browser only.</p>}</>;
    action = <button className="primary large" onClick={() => go(1)}>Get started</button>;
    extra = <button className="text-button" disabled={busy} onClick={onExamples}>{busy ? 'Adding examples…' : 'Explore example meetings'}</button>;
  } else if (step === 'how') {
    scene = <TracksScene />; title = 'No bot joins your call.';
    body = <p>Your side comes from the microphone, and the others from what your {storage.device} plays. Both are transcribed on this {storage.device}, and the audio never leaves it.</p>;
    action = <button className="primary large" onClick={() => go(1)}>Continue</button>;
  } else if (step === 'microphone') {
    scene = <Badge icon="mic" />; title = 'Allow the microphone.';
    body = <><p>macOS asks once. QuietNote listens only while you record.</p>
      <p className="subtle">The first time you record, macOS also asks for system audio recording, to hear the others through your {storage.device}’s sound output.</p></>;
    action = mic === 'granted' ? <button className="primary large" onClick={() => go(1)}>Continue</button>
      : mic === 'denied' ? <button className="secondary" onClick={() => go(1)}>Continue</button>
      : <button className="primary large" disabled={working} onClick={() => void allowMicrophone()}>{working ? 'Waiting for permission…' : 'Allow microphone'}</button>;
    if (mic === 'undetermined') extra = <button className="text-button" disabled={working} onClick={() => go(1)}>Not now</button>;
    if (mic === 'denied') extra = <p className="field-error" role="alert">Microphone access is off. Allow QuietNote under Privacy &amp; Security → Microphone. <button className="text-button" onClick={settings('microphone')}>Open System Settings</button></p>;
  } else if (step === 'calendar') {
    scene = <Badge icon="meeting" />; title = 'Name meetings after your calendar.';
    body = <p>QuietNote reads the calendars on this Mac, so a meeting is named after its event and knows who’s invited. It never changes them, never starts recording, and nothing is sent anywhere.</p>;
    const refused = calendar === 'denied' || calendar === 'restricted';
    action = refused || calendar === 'unavailable' ? <button className="secondary" onClick={() => go(1)}>Continue</button>
      : <button className="primary large" disabled={working} onClick={() => void useCalendar()}>{working ? 'Waiting for permission…' : 'Use my calendar'}</button>;
    if (!calendar) extra = <button className="text-button" disabled={working} onClick={() => go(1)}>Skip</button>;
    if (refused) extra = <p className="field-error" role="alert">{calendar === 'restricted' ? 'Calendar access is restricted on this Mac.' : 'macOS hasn’t allowed QuietNote to read your calendar. Allow it under Privacy & Security → Calendars.'} {calendar === 'denied' && <button className="text-button" onClick={settings('calendars')}>Open System Settings</button>}</p>;
  } else if (step === 'kind') {
    title = 'What meetings do you have most?';
    body = <>
      <div className="ob-kinds" role="radiogroup" aria-label="Meetings you have most">{kinds.map(k => <button key={k.template} type="button" role="radio" aria-checked={kind === k.template} className={`ob-kind ${kind === k.template ? 'selected' : ''}`} onClick={() => setKind(c => c === k.template ? '' : k.template)}>
        <strong>{k.label}</strong>{storage.desktop && <span>{k.headings}</span>}</button>)}</div>
      {storage.desktop && <p className="subtle">Enhanced notes start from the matching template. You can pick another each time.</p>}</>;
    action = chosen ? <button className="primary large" onClick={() => { onPreference('noteTemplate', chosen.template); go(1); }}>Continue</button>
      : <button className="secondary" onClick={() => go(1)}>Skip</button>;
  } else {
    scene = <Folder />; title = 'Name your first project.';
    body = <form className="ob-project" id={fieldId} onSubmit={e => { e.preventDefault(); void create(); }}>
      <p>Projects group meetings: a client, a team, a class. You can add more any time.</p>
      <label className="field">Project name<input value={name} maxLength={60} aria-invalid={Boolean(error)} onChange={e => { setName(e.target.value); setError(''); }} /></label>
      {error && <p className="field-error" role="alert">{error}</p>}
      {live.detectsCalls && preferences.detectCalls !== false && <p className="ob-fact"><Icon name="info" size={14} />When Zoom, Teams, FaceTime, Slack or a browser starts using the microphone, QuietNote offers to record. It never starts by itself.</p>}
      {live.detectsCalls && <p className="ob-fact"><Icon name="info" size={14} />QuietNote opens at login, in the menu bar, so it’s there for your calls. You can turn this off in Settings.</p>}
    </form>;
    action = <button className="primary large" type="submit" form={fieldId} disabled={working}>{working ? 'Creating…' : 'Create project'}</button>;
  }
  return <div className="onboarding" data-tauri-drag-region>
    <div key={`step-${step}`} className={`ob-step ${moved.current ? direction : ''}`}>
      {scene}
      <h1 ref={heading} tabIndex={-1}>{title}</h1>
      <div className="ob-body">{body}</div>
      {step !== 'kind' && step !== 'project' && error && <p className="field-error" role="alert">{error}</p>}
    </div>
    {/* Keyed by step: a click that moves on mustn't land on the next step's button (Create project submits). */}
    <div className={`ob-footer ${index ? '' : 'first'}`} key={`footer-${step}`}>
      {index > 0 && <button className="text-button ob-back" disabled={working} onClick={() => go(-1)}><Icon name="back" size={15} />Back</button>}
      <div className="ob-actions">{extra}{action}</div>
    </div>
    <p className="sr-only" aria-live="polite">Step {index + 1} of {steps.length}</p>
    <div className="ob-dots" aria-hidden="true">{steps.map((s, i) => <i key={s} className={i === index ? 'on' : undefined} />)}</div>
  </div>;
}
