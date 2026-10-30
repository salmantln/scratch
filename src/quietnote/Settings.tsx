import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Icon } from './Icon';
import { Hush } from './Hush';
import { getVersion } from '@tauri-apps/api/app';
import { Subscription } from './License';
import { accelerator, actions, bound, globalDefault, globalRecord, label, problem } from './shortcuts';
import { appearance, calendarAccess, callAccessibility, cliSetupCommand, desktop, device, diskEncryption, licenseStatus, mcpAgents, mcpConfig, ollamaModels, openPrivacySettings, removeSummaryKey, saveSummaryKey, setGlobalShortcut, setMcpAgent, type Agent, type PrivacyPreferences } from './storage';
export type SettingsSection = 'General' | 'Privacy' | 'Recording' | 'Suggestions' | 'Appearance' | 'Shortcuts' | 'Local archive' | 'About';
const mac = /Mac/.test(navigator.userAgent);
/** What this copy can do, which decides the pages Settings has: a page with nothing on it isn't listed. */
export type SettingsCan = { recording: boolean; detectsCalls: boolean };
const pages: [SettingsSection, Parameters<typeof Icon>[0]['name'], (can: SettingsCan) => boolean][] = [
  ['General', 'person', () => true], ['Privacy', 'privacy', () => true], ['Recording', 'mic', can => can.recording || can.detectsCalls],
  ['Suggestions', 'sparkle', can => can.recording && desktop], ['Appearance', 'appearance', () => true], ['Shortcuts', 'keyboard', () => true],
  ['Local archive', 'archive', () => true], ['About', 'info', () => true],
];
export const settingsSections = (can: SettingsCan) => pages.filter(([, , shown]) => shown(can));
/** Whether FileVault encrypts the disk (macOS), checked while `active` and again on coming back from System Settings. */
export function useDisk(active: boolean) {
  const [disk, setDisk] = useState('');
  useEffect(() => {
    if (!active || !desktop || !mac) return;
    let cancelled = false;
    const check = () => { diskEncryption().then(d => { if (!cancelled) setDisk(d); }).catch(() => { if (!cancelled) setDisk('unknown'); }); };
    check();
    window.addEventListener('focus', check);
    return () => { cancelled = true; window.removeEventListener('focus', check); };
  }, [active]);
  return disk;
}
export const diskAtRisk = (disk: string) => disk === 'off' || disk === 'decrypting';
/** Settings' own sidebar, in place of the app's while Settings is open. Privacy has a dot while something there needs attention. */
export function SettingsNav({ can, section, attention, onSection, onBack }: { can: SettingsCan; section: SettingsSection; attention: boolean; onSection: (section: SettingsSection) => void; onBack: () => void }) {
  return <>
    <div className="sidebar-top settings-top">
      <button className="sidebar-item settings-back" title="Back to meetings" onClick={onBack}><Icon name="back" size={16} /><span className="label">Back to meetings</span></button>
      <h2 className="settings-title">Settings</h2>
    </div>
    <nav className="sidebar-scroll" aria-label="Settings sections">{settingsSections(can).map(([name, icon]) => <button key={name} className={`sidebar-item ${section === name ? 'active' : ''}`} aria-current={section === name ? 'page' : undefined} title={name} onClick={() => onSection(name)}>
      <Icon name={icon} size={16} /><span className="label">{name}</span>{name === 'Privacy' && attention && <i className="attention-dot" role="img" aria-label="Needs attention" />}</button>)}</nav>
  </>;
}
/** One shortcut: click, then press the keys (Esc cancels). `optional` adds a switch, for the one that works from any app. */
function KeyRow({ name, description, value, fallback, check, onSet, optional }: {
  name: string; description?: string; value: string; fallback: string; check: (accel: string) => string; onSet: (accel: string) => Promise<void> | void;
  optional?: { on: boolean; onToggle: (on: boolean) => Promise<void> };
}) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  async function set(accel: string) {
    const why = check(accel);
    if (why) { setError(why); return; }
    setListening(false); setError('');
    try { await onSet(accel); } catch (e) { setError(String(e).replace(/^Error: /, '')); }
  }
  function keyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    // Tab still leaves, and stops listening on the way out.
    if (!listening || (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey)) return;
    // Kept from the window's own shortcuts while a new one is pressed.
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { setListening(false); setError(''); return; }
    const accel = accelerator(event.nativeEvent);
    if (accel) void set(accel);
  }
  async function toggle(on: boolean) {
    setError('');
    try { await optional!.onToggle(on); } catch (e) { setError(String(e).replace(/^Error: /, '')); }
  }
  const on = optional ? optional.on : true;
  return <div className="setting-row"><div><div className="setting-title">{name}</div>{description && <p>{description}</p>}{error && <p className="field-error" role="alert">{error}</p>}</div>
    <div className="key-controls">
      {on && value !== fallback && <button className="text-button" onClick={() => void set(fallback)}>Reset</button>}
      {on && <button type="button" className={`key-field ${listening ? 'listening' : ''}`} aria-label={`${name} shortcut`} onClick={() => { setListening(l => !l); setError(''); }} onBlur={() => setListening(false)} onKeyDown={keyDown}>{listening ? 'Press keys…' : label(value)}</button>}
      {optional && <button type="button" className={`toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={name} onClick={() => void toggle(!on)}><span /></button>}
    </div></div>;
}
/** The main actions' keys, and Start recording from any app (registered by Rust where recording is real). */
function Shortcuts({ values, onChange, anyApp }: { values: PrivacyPreferences; onChange: (key: string, value: PrivacyPreferences[string]) => void; anyApp: boolean }) {
  const global = globalRecord(values);
  async function setGlobal(accel: string) { await setGlobalShortcut(accel); onChange('globalRecord', accel); }
  return <>
    <h1>Shortcuts</h1>
    <p className="lede">Click a shortcut, then press the keys you want. Esc cancels.</p>
    <section><h2>In QuietNote</h2>
      {actions.map(a => <KeyRow key={a.key} name={a.name} value={bound(values, a.action)} fallback={a.fallback} check={accel => problem(accel, a.action, values)} onSet={accel => onChange(a.key, accel)} />)}
      <p className="group-note">Always: {label('CmdOrCtrl+P')} and {label('CmdOrCtrl+Shift+F')} search, {label('CmdOrCtrl+Shift+Enter')} shows or hides the sidebar, and {label('CmdOrCtrl+1')}–{label('CmdOrCtrl+9').slice(-1)} open your first nine projects.</p>
    </section>
    {anyApp && <section><h2>From any app</h2>
      <KeyRow name="Start recording from any app" description="Works while QuietNote is in the background or hidden, for example during a Zoom call. It records only when you press it." value={global || globalDefault} fallback={globalDefault}
        check={accel => problem(accel, 'global', values)} onSet={setGlobal} optional={{ on: Boolean(global), onToggle: on => setGlobal(on ? globalDefault : '') }} />
    </section>}
  </>;
}
/** Your name, saved when you leave the field, so action items you own come first (with those for “You”). */
function NameRow({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const [name, setName] = useState(value);
  const save = () => { if (name.trim() !== value) onChange(name.trim()); };
  return <div className="setting-row"><div><div className="setting-title">Your name</div><p>Puts your action items first. {desktop ? `Stays on this ${device}.` : 'Stays in this browser.'}</p></div>
    <label className="field name-field"><input aria-label="Your name" value={name} maxLength={60} placeholder="Optional" autoComplete="name" onChange={e => setName(e.target.value)} onBlur={save} onKeyDown={e => { if (e.key === 'Enter') save(); }} /></label></div>;
}
/** Who drafts summary suggestions. The Anthropic key is checked, then kept in the Keychain; Ollama runs on this computer. */
function SummarySettings({ values, onChange, summaryKey, onSummaryKey }: { values: PrivacyPreferences; onChange: (key: string, value: PrivacyPreferences[string]) => void; summaryKey: boolean; onSummaryKey: (saved: boolean) => void }) {
  const provider = values.summaryProvider === 'anthropic' || values.summaryProvider === 'ollama' ? values.summaryProvider : '';
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [check, setCheck] = useState(0);
  useEffect(() => {
    if (provider !== 'ollama') return;
    let cancelled = false;
    setModels(null); setError('');
    ollamaModels().then(m => { if (!cancelled) setModels(m); }).catch(e => { if (!cancelled) { setModels([]); setError(String(e).replace(/^Error: /, '')); } });
    return () => { cancelled = true; };
  }, [provider, check]);
  async function save() {
    setBusy(true); setError('');
    try { await saveSummaryKey(key); setKey(''); onSummaryKey(true); } catch (e) { setError(String(e).replace(/^Error: /, '')); }
    setBusy(false);
  }
  async function remove() {
    try { await removeSummaryKey(); onSummaryKey(false); } catch (e) { setError(String(e).replace(/^Error: /, '')); }
  }
  const model = typeof values.ollamaModel === 'string' ? values.ollamaModel : '';
  return <section>
    <div className="setting-row"><div><div className="setting-title">Drafted by</div><p>{provider === 'anthropic' ? 'Claude, with your own Anthropic key. When you ask, the meeting’s transcript text is sent to Anthropic, with your notes when you enhance them and the invited people’s names when you ask for names. Audio and titles are never sent.' : provider === 'ollama' ? 'A model in Ollama on this computer. Nothing leaves this computer.' : 'Off. Nothing is drafted and nothing is sent.'}</p></div>
      <select aria-label="Drafted by" value={provider} onChange={e => { setError(''); onChange('summaryProvider', e.target.value); }}><option value="">Off</option><option value="anthropic">Claude (your Anthropic key)</option><option value="ollama">Ollama on this computer</option></select></div>
    {provider === 'anthropic' && (summaryKey
      ? <div className="setting-row"><div><div className="setting-title">Anthropic key saved</div><p>It’s kept in your macOS Keychain and used only when you ask for suggestions. Anthropic’s API terms apply to what you send.</p></div><button className="text-button" onClick={() => void remove()}>Remove key</button></div>
      : <form className="setting-row key-row" onSubmit={e => { e.preventDefault(); if (key.trim()) void save(); }}><div className="setting-title">Anthropic API key</div><p>Create one at console.anthropic.com. QuietNote checks it, then keeps it in your macOS Keychain.</p>
        <div className="token-field"><input type="password" aria-label="Anthropic API key" placeholder="Paste your key" value={key} autoComplete="off" spellCheck={false} aria-invalid={Boolean(error)} onChange={e => { setKey(e.target.value); setError(''); }} />
        <button className="secondary" type="submit" disabled={busy || !key.trim()}>{busy ? 'Checking…' : 'Save key'}</button></div></form>)}
    {provider === 'ollama' && (models === null ? <p className="subtle">Looking for Ollama…</p>
      : models.length ? <div className="setting-row"><div><div className="setting-title">Model</div><p>Small models miss or invent details more often, so check each suggestion against its quote. Larger models do better but need more memory.</p></div>
        <select aria-label="Ollama model" value={model} onChange={e => onChange('ollamaModel', e.target.value)}><option value="" disabled>Choose a model</option>{models.map(m => <option key={m} value={m}>{m}</option>)}</select></div>
      : <div className="setting-row"><div><div className="setting-title">{error ? 'Ollama isn’t running' : 'No models in Ollama'}</div><p>{error ? 'Install Ollama from ollama.com and open it' : 'Pull a model in Ollama'}, then check again.</p></div><button className="text-button" onClick={() => setCheck(c => c + 1)}>Check again</button></div>)}
    {error && provider === 'anthropic' && <p className="field-error setting-error" role="alert">{error}</p>}
  </section>;
}
/** The AI apps on this computer that can read the archive through `quietnote mcp`, each added or removed in its own settings file. */
function AiApps() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [busy, setBusy] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [mcp, setMcp] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    let cancelled = false;
    // Again on coming back, after installing an app or editing its settings.
    const check = () => { mcpAgents().then(a => { if (!cancelled) setAgents(a); }).catch(() => { if (!cancelled) setAgents([]); }); };
    check();
    window.addEventListener('focus', check);
    return () => { cancelled = true; window.removeEventListener('focus', check); };
  }, []);
  async function set(agent: Agent, on: boolean) {
    setBusy(agent.id); setErrors(e => ({ ...e, [agent.id]: '' }));
    try { const next = await setMcpAgent(agent.id, on); setAgents(list => list?.map(a => a.id === next.id ? next : a) ?? null); }
    catch (e) { setErrors(errs => ({ ...errs, [agent.id]: String(e).replace(/^Error: /, '') })); }
    setBusy('');
  }
  async function copyMcp() {
    try { await writeText(await mcpConfig()); setMcp('copied'); window.setTimeout(() => setMcp('idle'), 2500); }
    catch { setMcp('failed'); }
  }
  const file = (path: string) => path.replace(/^\/Users\/[^/]+/, '~');
  return <section><h2>Use with AI apps</h2>
    <p className="group-note">Lets the AI apps on this computer read your meetings through MCP: list, search, notes and transcripts. They can’t change anything, and QuietNote runs only while an app uses it. What an app sends to its own servers is up to that app; most send what they read to their AI model.</p>
    {agents?.map(agent => {
      const on = agent.state === 'on' || agent.state === 'other';
      const error = errors[agent.id] || agent.problem;
      return <div className="setting-row" key={agent.id}><div><div className="setting-title">{agent.name}</div>
        {agent.state !== 'unreadable' && <p>{agent.state === 'on' ? `Added to ${file(agent.path)}. Restart ${agent.name} if it’s open.` : agent.state === 'other' ? 'Set up for another copy of QuietNote, which may have moved.' : `Adds QuietNote to ${file(agent.path)}.`}
          {agent.state === 'other' && <> <button className="text-button" disabled={busy === agent.id} onClick={() => void set(agent, true)}>Use this copy</button></>}</p>}
        {error && <p className="field-error" role="alert">{error}</p>}</div>
        {agent.state !== 'unreadable' && <button type="button" className={`toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={`Use with ${agent.name}`} disabled={busy === agent.id} onClick={() => void set(agent, !on)}><span /></button>}</div>;
    })}
    <div className="setting-row"><div><div className="setting-title">{agents?.length ? 'Another app' : 'Any MCP app'}</div><p>Paste the copied configuration into the app’s MCP settings. ChatGPT connects only to servers on the internet, so it can’t use QuietNote on this computer.</p>{mcp === 'failed' && <p className="field-error" role="alert">Couldn’t copy the configuration.</p>}</div><button className="text-button" onClick={() => void copyMcp()}><Icon name="copy" size={15} />{mcp === 'copied' ? 'Copied' : 'Copy configuration'}</button></div>
  </section>;
}
export function Settings({ recording, detectsCalls = false, liveTranscript = false, disk = '', summaryKey = false, onSummaryKey = () => {}, section, values, onChange, root, hasAllExamples, onOpenArchive, onReload, onWorkspace, onExamples }: {
  recording: boolean; detectsCalls?: boolean; liveTranscript?: boolean; disk?: string; summaryKey?: boolean; onSummaryKey?: (saved: boolean) => void; section: SettingsSection; values: PrivacyPreferences; onChange: (key: string, value: PrivacyPreferences[string]) => void; root: string; hasAllExamples: boolean;
  onOpenArchive: () => void; onReload: () => void; onWorkspace: () => void; onExamples: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [version, setVersion] = useState('');
  useEffect(() => { if (desktop) getVersion().then(setVersion).catch(() => setVersion('')); }, []);
  const [cli, setCli] = useState<'idle' | 'copied' | 'failed'>('idle');
  // The Calendar permission, checked while the calendar is on (and on coming back from System Settings).
  const [calendar, setCalendar] = useState('');
  const calendarOn = desktop && mac && values.calendar === true;
  useEffect(() => {
    if (!calendarOn) return;
    let cancelled = false;
    const check = () => { calendarAccess(false).then(a => { if (!cancelled) setCalendar(a); }).catch(() => { if (!cancelled) setCalendar('denied'); }); };
    check();
    window.addEventListener('focus', check);
    return () => { cancelled = true; window.removeEventListener('focus', check); };
  }, [calendarOn]);
  // Whether macOS lets QuietNote read browser titles, checked while that setting is on.
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const confirming = detectsCalls && values.detectCalls !== false && values.confirmMeetings === true;
  useEffect(() => {
    if (!confirming) return;
    let cancelled = false;
    const check = () => { callAccessibility(false).then(a => { if (!cancelled) setAllowed(a); }).catch(() => { if (!cancelled) setAllowed(false); }); };
    check();
    // Coming back from System Settings.
    window.addEventListener('focus', check);
    return () => { cancelled = true; window.removeEventListener('focus', check); };
  }, [confirming]);
  // Whether this build sells subscriptions, whose key is checked once a day: Privacy says so.
  const [licenses, setLicenses] = useState(false);
  useEffect(() => { if (desktop) licenseStatus().then(s => setLicenses(s.available)).catch(() => setLicenses(false)); }, []);
  const flag = (key: string, fallback: boolean) => typeof values[key] === 'boolean' ? values[key] as boolean : fallback;
  const theme = appearance(values);
  /** A switch with one sentence, which can say what the setting does as it's set now. */
  function toggle(key: string, title: string, description: string | ((on: boolean) => string), fallback: boolean, disabled = false) {
    const checked = flag(key, fallback);
    return <div className="setting-row" key={key}><div><div className="setting-title">{title}</div><p>{typeof description === 'string' ? description : description(checked)}</p></div><button type="button" className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} aria-label={title} disabled={disabled} onClick={() => onChange(key, !checked)}><span /></button></div>;
  }
  const muted = Array.isArray(values.mutedCallApps) ? values.mutedCallApps : [];
  const offering = detectsCalls && flag('detectCalls', true);
  const allow = (pane: 'calendars' | 'accessibility') => <button className="text-button" onClick={() => void openPrivacySettings(pane).catch(() => { /* The line says what's missing. */ })}>Allow in System Settings</button>;
  // Everything this copy of QuietNote can send, set up or not: Claude needs recording, a license a build that sells one.
  const sends = [
    ...recording ? ['A transcript’s text to Claude when you ask for suggestions, with your notes when you enhance them'] : [],
    'Action items you send to Linear or GitHub',
    ...licenses ? ['Your license key to Lemon Squeezy when you activate it'] : [],
  ];
  const kept = recording ? 'Recordings, transcripts and notes. Audio is transcribed here, by a model bundled with the app.' : 'Your meetings, as files in a local archive.';
  const encrypted = disk === 'on' ? ' FileVault encrypts the disk they’re on.' : disk === 'encrypting' ? ' FileVault is encrypting the disk.' : '';
  async function copyCli() {
    try { await writeText(await cliSetupCommand()); setCli('copied'); window.setTimeout(() => setCli('idle'), 2500); }
    catch { setCli('failed'); }
  }
  async function copyPath() {
    try { if (desktop) await writeText(root); else await navigator.clipboard.writeText(root); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { setCopied(false); }
  }
  return <div className="settings-page">
    <div className="settings-content">
      {section === 'General' && <>
        <h1>General</h1>
        <p className="lede">Who you are in your meetings.</p>
        <section><NameRow value={typeof values.userName === 'string' ? values.userName : ''} onChange={name => onChange('userName', name)} /></section>
      </>}
      {section === 'Privacy' && <>
        <h1>Privacy</h1>
        <p className="lede">{desktop ? `What stays on this ${device}, and what leaves it${licenses ? '' : ' only when you ask'}.` : 'What QuietNote does with your meetings today, and what is still planned.'}</p>
        <dl className="verdict">
          <div><dt>{desktop ? `Stays on this ${device}` : 'Stays in this browser'}</dt><dd>{desktop ? kept + encrypted : 'Your meetings, in this browser’s local storage. Nothing is uploaded.'}</dd></div>
          {desktop && <div><dt>Leaves when you ask</dt><dd>{sends.map(line => <span key={line}>{line}</span>)}</dd></div>}
          {licenses && <div><dt>Once a day</dt><dd>Your license key and this {device}’s activation ID, to Lemon Squeezy, to check your subscription. Nothing about your meetings.</dd></div>}
          <div><dt>Never</dt><dd>A meeting bot, an account, cloud sync, or recording before you press Start.</dd></div>
        </dl>
        {diskAtRisk(disk) && <div className="attention"><Icon name="warning" size={20} /><div><div className="setting-title">{disk === 'off' ? 'FileVault is off' : 'FileVault is being turned off'}</div><p>{`Anyone with this Mac’s disk could read your ${recording ? 'recordings, transcripts and notes' : 'meetings'}.`}</p></div>
          <button className="secondary" onClick={() => void openPrivacySettings('fileVault').catch(() => { /* The line says what's wrong. */ })}>Turn on FileVault…</button></div>}
        {recording && <section><h2>Recordings</h2>
          {mac && toggle('encryptAudio', 'Encrypt recordings', 'Only QuietNote can play them, with a key kept in your Keychain. Applies to new recordings.', true)}
          {mac && toggle('backupAudio', 'Back up recordings with Time Machine', on => on ? 'On: backups hold your recordings too.' : 'Off: backups hold your transcripts and notes, never the audio.', false)}
          {toggle('deleteAudio', 'Delete audio after transcribing', on => on ? 'On: audio is deleted once its transcript is saved, and can’t be transcribed again.' : 'Off: audio is kept, so you can export it or transcribe it again.', false)}
        </section>}
        {(desktop && mac || offering) && <section><h2>What QuietNote reads</h2>
          {desktop && mac && <div className="setting-row"><div><div className="setting-title">Your calendar</div><p>Names meetings after their events and knows who’s invited. Never changed, never sent.</p>
            {calendarOn && (calendar === 'denied' || calendar === 'restricted') && <p className="setting-status" role="alert">{calendar === 'restricted' ? 'Not working: calendar access is restricted on this Mac.' : 'Not working yet: macOS hasn’t allowed it.'} {calendar === 'denied' && allow('calendars')}</p>}</div>
            <button type="button" className={`toggle ${calendarOn ? 'on' : ''}`} role="switch" aria-checked={calendarOn} aria-label="Your calendar" onClick={() => {
              onChange('calendar', !calendarOn);
              if (!calendarOn) void calendarAccess(true).then(setCalendar).catch(() => setCalendar('denied'));
            }}><span /></button></div>}
          {offering && <div className="setting-row"><div><div className="setting-title">Browser tab titles</div><p>Read only while a browser uses the microphone, to tell a Meet or Teams call from a video. Nothing is kept.</p>
            {confirming && allowed === false && <p className="setting-status" role="alert">Not working yet: macOS hasn’t allowed it, so every browser is offered. {allow('accessibility')}</p>}</div>
            <button type="button" className={`toggle ${confirming ? 'on' : ''}`} role="switch" aria-checked={confirming} aria-label="Browser tab titles" onClick={() => {
              onChange('confirmMeetings', !confirming);
              if (!confirming) void callAccessibility(true).then(setAllowed).catch(() => setAllowed(false));
            }}><span /></button></div>}
        </section>}
        {!recording && <section className="planned-group"><h2>Planned <span className="h2-note">Not active yet</span></h2>
          <p className="group-note">These choices are saved for when audio capture and processing exist. They have no effect in this version.</p>
          {toggle('audio', 'Keep audio on this device', 'No audio files are created today.', true)}
          {toggle('deleteAudio', 'Delete audio after processing', 'No audio exists to delete, and no deletion runs.', false)}
          {toggle('local', 'Prefer on-device processing', 'Transcription isn’t implemented yet.', true)}
          {toggle('cloud', 'Allow cloud processing', 'Unavailable. No processing service is connected.', false, true)}
          <div className="setting-row"><div><div className="setting-title">Keep meeting data</div><p>Saved preference only. QuietNote never deletes files automatically.</p></div><select aria-label="Keep meeting data" value={String(values.retention ?? 'forever')} onChange={e => onChange('retention', e.target.value)}><option value="forever">Forever</option><option value="30">30 days</option><option value="7">7 days</option></select></div>
        </section>}
      </>}
      {section === 'Recording' && <>
        <h1>Recording</h1>
        <p className="lede">When QuietNote offers to record, and what it does while it records.</p>
        {detectsCalls && <section><h2>Calls</h2>
          {toggle('detectCalls', 'Offer to record calls', 'A small panel offers to record when Zoom, Teams, FaceTime, Slack or a browser uses the microphone. Nothing records until you press Start.', true)}
          {offering && muted.map(app => <div className="setting-row nested" key={`muted-${app}`}><div><div className="setting-title">Not offered for {app}</div><p>You turned the panel off for {app} calls.</p></div><button className="text-button" onClick={() => onChange('mutedCallApps', muted.filter(a => a !== app))}>Notify again</button></div>)}
          {toggle('openAtLogin', 'Open at login', 'Starts in the menu bar, so it can notice your calls. It never records by itself.', true)}
        </section>}
        {recording && <section><h2>While recording</h2>
          {liveTranscript && toggle('liveTranscript', 'Show the transcript while recording', 'A rough draft a few seconds behind, made again in full when you stop. Uses up to 1 GB more memory.', true)}
          {toggle('echoCancellation', 'Remove call audio from your microphone', 'Keeps the others’ words out of your track. Turn it off if your voice sounds cut off; it applies from the next recording.', true)}
          {mac && toggle('pauseMedia', 'Pause music when recording starts', 'So it isn’t recorded too. Nothing starts playing again afterwards.', true)}
        </section>}
        {recording && <section><h2>Transcripts</h2>
          {toggle('cleanTranscript', 'Remove filler words', 'Opens in Clean view, without “um” and “uh”. Verbatim keeps every word.', true)}
          {mac && toggle('separateSpeakers', 'Tell the others apart', 'Speaker 1, Speaker 2… by how voices sound, never who they are. About two minutes per hour of audio.', true)}
        </section>}
      </>}
      {section === 'Suggestions' && <>
        <h1>Suggestions</h1>
        <p className="lede">When you ask, a model drafts a summary and action items from a recorded transcript, or writes up your notes under a template. Each line quotes the transcript or your notes, and nothing is saved until you add it. Your own templates are Markdown files in the archive’s .templates folder.</p>
        <SummarySettings values={values} onChange={onChange} summaryKey={summaryKey} onSummaryKey={onSummaryKey} />
      </>}
      {section === 'Appearance' && <>
        <h1>Appearance</h1>
        <p className="lede">How QuietNote looks, and how it shows what it’s doing.</p>
        <section><div className="setting-row"><div><div className="setting-title">Theme</div><p>{theme === 'system' ? `Light or dark, as this ${mac ? 'Mac' : 'computer'} is set.` : theme === 'dark' ? 'Dark, with a white Hush.' : 'Light.'}{desktop ? ' The Markdown workspace follows it too.' : ''}</p></div>
          <div className="segmented" role="group" aria-label="Theme">{(['system', 'light', 'dark'] as const).map(mode => <button key={mode} type="button" aria-pressed={theme === mode} onClick={() => onChange('theme', mode)}>{mode === 'system' ? 'System' : mode === 'light' ? 'Light' : 'Dark'}</button>)}</div></div>
          <div className="setting-row hush-setting"><Hush mood="ready" size={56} /><div><div className="setting-title">Show Hush</div><p>His face shows what QuietNote is doing, on the Home card{detectsCalls ? ', the call panel' : ''}{desktop && mac ? ' and in the menu bar' : ''}. He never joins a call. Turned off, the status dot and the logo come back.</p></div>
          <button type="button" className={`toggle ${flag('showHush', true) ? 'on' : ''}`} role="switch" aria-checked={flag('showHush', true)} aria-label="Show Hush" onClick={() => onChange('showHush', !flag('showHush', true))}><span /></button></div></section>
      </>}
      {section === 'Shortcuts' && <Shortcuts values={values} onChange={onChange} anyApp={recording && desktop} />}
      {section === 'Local archive' && <>
        <h1>Local archive</h1>
        <p className="lede">{desktop ? 'QuietNote stores meeting files in a local archive that you control. Each meeting is a folder of Markdown files you can open in any editor.' : 'This browser preview keeps meetings in this browser only. The desktop app stores them as Markdown files on your device.'}</p>
        <div className="button-row">{desktop && <button className="secondary" onClick={onOpenArchive}><Icon name="open" size={15} />Open archive</button>}<button className="secondary" onClick={onReload}><Icon name="refresh" size={15} />Reload from disk</button></div>
        {desktop && <AiApps />}
        <details className="advanced"><summary>Advanced</summary>
          {desktop && <div className="setting-row"><div><div className="setting-title">Location</div><p className="path">{root}</p></div><button className="text-button" onClick={() => void copyPath()}><Icon name="copy" size={15} />{copied ? 'Copied' : 'Copy path'}</button></div>}
          {desktop && mac && <div className="setting-row"><div><div className="setting-title">Command line</div><p>Read meetings in Terminal: <code>quietnote meetings</code>, <code>show</code>, <code>transcript</code> and <code>search</code>. It only reads the archive. To set it up, paste the copied command into Terminal; it asks for your password to link QuietNote into /usr/local/bin.</p>{cli === 'failed' && <p className="field-error" role="alert">Couldn’t copy the command.</p>}</div><button className="text-button" onClick={() => void copyCli()}><Icon name="copy" size={15} />{cli === 'copied' ? 'Copied' : 'Copy setup command'}</button></div>}
          <div className="setting-row"><div><div className="setting-title">Markdown workspace</div><p>Browse and edit the archive’s files in the full Markdown editor.</p></div><button className="text-button" disabled={!desktop} onClick={onWorkspace}>{desktop ? 'Open' : 'Desktop only'}</button></div>
          {!hasAllExamples && <div className="setting-row"><div><div className="setting-title">Example meetings</div><p>Add six illustrative meetings, marked Example, to see a finished workspace.</p></div><button className="text-button" onClick={onExamples}>Add examples</button></div>}
        </details>
      </>}
      {section === 'About' && <>
        <h1>About</h1>
        <p className="lede">QuietNote{version ? ` ${version}` : ''} · Prototype</p>
        <p className="body-copy">Made by Sarl Studio · <a href="https://x.com/salmantln" target="_blank" rel="noreferrer">@salmantln</a></p>
        <p className="body-copy">QuietNote is open source under the GNU Affero General Public License, version 3. The code it takes from Scratch stays under the MIT license.</p>
        {desktop && <Subscription />}
        {recording && <p className="body-copy">Transcription uses <a href="https://github.com/ggml-org/whisper.cpp" target="_blank" rel="noreferrer">whisper.cpp</a> (MIT) with OpenAI’s Whisper large-v3-turbo model (MIT) and the Silero voice activity detector (MIT), all running on this device. Echo cancellation is WebRTC’s AEC3, through <a href="https://github.com/dignifiedquire/sonora" target="_blank" rel="noreferrer">Sonora</a> (BSD-3-Clause).</p>}
        {recording && mac && <p className="body-copy">Voices are told apart, and English live transcripts are made, with <a href="https://github.com/k2-fsa/sherpa-onnx" target="_blank" rel="noreferrer">sherpa-onnx</a> (Apache-2.0) and ONNX Runtime (MIT), using pyannote segmentation 3.0 (MIT), 3D-Speaker ERes2Net (Apache-2.0) and NVIDIA’s Parakeet TDT 110M (CC BY 4.0).</p>}
        <p className="body-copy">Service logos in Connections come from Iconify “logos” (CC0), vscode-icons (MIT) and Simple Icons (CC0). Trademarks belong to their owners. Apple and Things icons are read from apps installed on this Mac.</p>
      </>}
    </div>
  </div>;
}
