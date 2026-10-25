import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon, Logo } from './Icon';
import { Hush } from './Hush';
import { validProjectName } from './model';
import * as storage from './storage';
import { bound, label } from './shortcuts';

type Step = 'hello' | 'access' | 'project';
/** The kinds of meeting to choose from: each picks its built-in note template and names the first project. */
const kinds: { template: string; label: string; project: string }[] = [
  { template: '1:1', label: '1:1s', project: 'One-on-ones' },
  { template: 'Standup', label: 'Standups', project: 'Team' },
  { template: 'Sales call', label: 'Sales calls', project: 'Sales' },
  { template: 'User interview', label: 'User interviews', project: 'Research' },
  { template: 'Project kickoff', label: 'Project kickoffs', project: 'Projects' },
  { template: 'General', label: 'A bit of everything', project: 'Work' },
];
const mac = storage.device === 'Mac';
/** Illustration only: shapes and the app's own labels, never words anyone said. Shown when Hush is turned off. */
function CallScene() {
  return <div className="ob-call" aria-hidden="true">
    <div className="ob-window"><span /><span /><span /><span /></div>
    <div className="ob-notes"><Logo size={14} /><i /><i /><i /><i /></div>
  </div>;
}
function Access({ icon, name, why, alert, children }: { icon: 'mic' | 'meeting'; name: string; why: string; alert?: boolean; children: ReactNode }) {
  return <div className="ob-access">
    <span className="ob-access-icon"><Icon name={icon} size={18} /></span>
    <div><strong>{name}</strong><p role={alert ? 'alert' : undefined} className={alert ? 'field-error' : undefined}>{why}</p></div>
    {children}
  </div>;
}
const Allowed = () => <span className="ob-allowed"><Icon name="check" size={14} />Allowed</span>;
type Props = {
  live: storage.CaptureState; preferences: storage.PrivacyPreferences; busy: boolean;
  onPreference: (key: string, value: storage.PrivacyPreferences[string]) => void; onCreate: (project: string) => Promise<void>; onExamples: () => void;
};
/** First launch in three screens at most: hello; the permissions, each explained before macOS asks; then the first
 * project, with one optional question. Nothing records here. */
export function Onboarding({ live, preferences, busy, onPreference, onCreate, onExamples }: Props) {
  // Fixed when it opens, so a permission granted along the way doesn't remove the row you're on.
  const [asks] = useState(() => ({
    mic: live.available && mac && (live.microphone === 'undetermined' || live.microphone === 'denied'),
    calendar: storage.desktop && mac && preferences.calendar !== true,
  }));
  const steps: Step[] = ['hello', ...(asks.mic || asks.calendar ? ['access' as const] : []), 'project'];
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [kind, setKind] = useState(() => typeof preferences.noteTemplate === 'string' ? preferences.noteTemplate : '');
  const [mic, setMic] = useState(live.microphone);
  const [calendar, setCalendar] = useState('');
  const [asking, setAsking] = useState<'' | 'mic' | 'calendar'>('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  const fieldId = useId();
  const step = steps[index];
  const chosen = kinds.find(k => k.template === kind);
  // Untouched, the name follows the kind of meeting chosen.
  const [typed, setName] = useState<string | null>(null);
  const name = typed ?? chosen?.project ?? 'Work';
  // Each new step is announced from its heading, as a page would be.
  useEffect(() => { if (moved.current) heading.current?.focus(); }, [index]);
  const go = (by: 1 | -1) => { moved.current = true; setDirection(by > 0 ? 'forward' : 'back'); setError(''); setIndex(i => Math.min(steps.length - 1, Math.max(0, i + by))); };
  const settings = (pane: 'microphone' | 'calendars') => () => void storage.openPrivacySettings(pane).catch(() => { /* The row says where to go. */ });
  async function allowMicrophone() {
    setAsking('mic');
    try { setMic((await storage.allowMicrophone()).microphone); }
    catch (e) { setError(`Couldn’t ask for the microphone. ${String(e)}`); }
    finally { setAsking(''); }
  }
  async function useCalendar() {
    setAsking('calendar'); onPreference('calendar', true);
    try { setCalendar(await storage.calendarAccess(true)); }
    catch { setCalendar('denied'); }
    finally { setAsking(''); }
  }
  async function create() {
    const project = name.trim();
    const problem = validProjectName(project);
    if (problem) { setError(problem); return; }
    setWorking(true);
    if (chosen) onPreference('noteTemplate', chosen.template);
    try { await onCreate(project); }
    catch (e) { setError(String(e).replace(/^Error: /, '')); setWorking(false); }
  }
  let scene: ReactNode = null, extra: ReactNode = null, title: string, body: ReactNode, action: ReactNode;
  if (step === 'hello') {
    scene = <div className="ob-scene"><Hush mood="ready" size={96} fallback={<CallScene />} /></div>;
    title = 'Meeting notes, without a bot.';
    body = <><p>{live.available ? `Recorded and transcribed on this ${storage.device}.` : 'Notes and action items, kept on your device.'}</p>
      {!storage.desktop && <p className="subtle">Browser preview · saved in this browser only.</p>}</>;
    action = <button className="primary large" onClick={() => go(1)}>Get started</button>;
    extra = <button className="text-button" disabled={busy} onClick={onExamples}>{busy ? 'Adding examples…' : 'Explore example meetings'}</button>;
  } else if (step === 'access') {
    title = 'Allow access.';
    body = <div className="ob-access-list">
      {asks.mic && <Access icon="mic" name="Microphone" alert={mic === 'denied'} why={mic === 'denied' ? 'Microphone access is off. Allow it in System Settings.' : 'Hears your side, only while you record.'}>
        {mic === 'granted' ? <Allowed /> : mic === 'denied' ? <button className="text-button" onClick={settings('microphone')}>Open System Settings</button>
          : <button className="secondary" aria-label="Allow microphone" disabled={Boolean(asking)} onClick={() => void allowMicrophone()}>{asking === 'mic' ? 'Waiting…' : 'Allow'}</button>}
      </Access>}
      {asks.calendar && <Access icon="meeting" name="Calendar" alert={calendar === 'denied' || calendar === 'restricted'}
        why={calendar === 'denied' ? 'Calendar access is off. Allow it in System Settings.' : calendar === 'restricted' ? 'Calendar access is restricted on this Mac.' : 'Names meetings after their events. Optional.'}>
        {calendar === 'granted' ? <Allowed /> : calendar === 'denied' ? <button className="text-button" onClick={settings('calendars')}>Open System Settings</button>
          : calendar ? null : <button className="secondary" aria-label="Use my calendar" disabled={Boolean(asking)} onClick={() => void useCalendar()}>{asking === 'calendar' ? 'Waiting…' : 'Allow'}</button>}
      </Access>}
    </div>;
    action = <button className="primary large" disabled={Boolean(asking)} onClick={() => go(1)}>Continue</button>;
  } else {
    title = 'What meetings do you have most?';
    body = <form className="ob-project" id={fieldId} onSubmit={e => { e.preventDefault(); void create(); }}>
      <div className="ob-kinds" role="radiogroup" aria-label="Meetings you have most">{kinds.map(k => <button key={k.template} type="button" role="radio" aria-checked={kind === k.template} className={`ob-kind ${kind === k.template ? 'selected' : ''}`} onClick={() => setKind(c => c === k.template ? '' : k.template)}>{k.label}</button>)}</div>
      <label className="field">Project name<input value={name} maxLength={60} aria-invalid={Boolean(error)} onChange={e => { setName(e.target.value); setError(''); }} /></label>
      {error && <p className="field-error" role="alert">{error}</p>}
      {live.available && <p className="ob-fact">In person or on a call, press Start recording ({label(bound(preferences, 'record'))}) and the meeting is made for you.</p>}
      {live.detectsCalls && <p className="ob-fact">Opens at login in the menu bar{preferences.detectCalls !== false ? ' and offers to record when a call starts. It never starts by itself' : ''}.</p>}
    </form>;
    action = <button className="primary large" type="submit" form={fieldId} disabled={working}>{working ? 'Creating…' : 'Create project'}</button>;
  }
  return <div className="onboarding" data-tauri-drag-region>
    <div key={`step-${step}`} className={`ob-step ${moved.current ? direction : ''}`}>
      {scene}
      <h1 ref={heading} tabIndex={-1}>{title}</h1>
      <div className="ob-body">{body}</div>
      {step !== 'project' && error && <p className="field-error" role="alert">{error}</p>}
    </div>
    {/* Keyed by step: a click that moves on mustn't land on the next step's button (Create project submits). */}
    <div className={`ob-footer ${index ? '' : 'first'}`} key={`footer-${step}`}>
      {index > 0 && <button className="text-button ob-back" disabled={working || Boolean(asking)} onClick={() => go(-1)}><Icon name="back" size={15} />Back</button>}
      <div className="ob-actions">{extra}{action}</div>
    </div>
    <p className="sr-only" aria-live="polite">Step {index + 1} of {steps.length}</p>
    <div className="ob-dots" aria-hidden="true">{steps.map((s, i) => <i key={s} className={i === index ? 'on' : undefined} />)}</div>
  </div>;
}
