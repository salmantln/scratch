import { useEffect, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Icon } from './Icon';
import { serviceName } from './catalog';
import { calendarAccess, callAccessibility, cliSetupCommand, desktop, mcpConfig, ollamaModels, openPrivacySettings, removeSummaryKey, saveSummaryKey, type Connections, type PrivacyPreferences, type Service } from './storage';
export type SettingsSection = 'Privacy' | 'Local archive' | 'About';
const mac = /Mac/.test(navigator.userAgent);
const sections: [SettingsSection, 'privacy' | 'archive' | 'info'][] = [['Privacy', 'privacy'], ['Local archive', 'archive'], ['About', 'info']];
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
  return <section><h2>Summary suggestions</h2>
    <p className="group-note">When you ask, a model drafts a summary, decisions and action items from a recorded transcript, or writes up your notes under a template and fills them in from it. Each line quotes the transcript or your notes, and nothing is saved until you add it. Your own templates are Markdown files in the archive’s .templates folder (Enhance notes → Edit templates).</p>
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
export function Settings({ recording, detectsCalls = false, liveTranscript = false, connections, summaryKey = false, onSummaryKey = () => {}, section, onSection, values, onChange, root, hasAllExamples, onOpenArchive, onReload, onWorkspace, onExamples }: {
  recording: boolean; detectsCalls?: boolean; liveTranscript?: boolean; connections: Connections; summaryKey?: boolean; onSummaryKey?: (saved: boolean) => void; section: SettingsSection; onSection: (section: SettingsSection) => void; values: PrivacyPreferences; onChange: (key: string, value: PrivacyPreferences[string]) => void; root: string; hasAllExamples: boolean;
  onOpenArchive: () => void; onReload: () => void; onWorkspace: () => void; onExamples: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [cli, setCli] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [mcp, setMcp] = useState<'idle' | 'copied' | 'failed'>('idle');
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
  const connected = (Object.keys(connections) as Service[]).map(s => `${serviceName(s)} (as ${connections[s]!.account})`);
  const flag = (key: string, fallback: boolean) => typeof values[key] === 'boolean' ? values[key] as boolean : fallback;
  function toggle(key: string, title: string, description: string, fallback: boolean, disabled = false) {
    const checked = flag(key, fallback);
    return <div className="setting-row" key={key}><div><div className="setting-title">{title}</div><p>{description}</p></div><button type="button" className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} aria-label={title} disabled={disabled} onClick={() => onChange(key, !checked)}><span /></button></div>;
  }
  const muted = Array.isArray(values.mutedCallApps) ? values.mutedCallApps : [];
  const fact = (title: string, description: string) => <div className="setting-row fact" key={title}><Icon name="check" size={16} /><div><div className="setting-title">{title}</div><p>{description}</p></div></div>;
  async function copyCli() {
    try { await writeText(await cliSetupCommand()); setCli('copied'); window.setTimeout(() => setCli('idle'), 2500); }
    catch { setCli('failed'); }
  }
  async function copyMcp() {
    try { await writeText(await mcpConfig()); setMcp('copied'); window.setTimeout(() => setMcp('idle'), 2500); }
    catch { setMcp('failed'); }
  }
  async function copyPath() {
    try { if (desktop) await writeText(root); else await navigator.clipboard.writeText(root); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { setCopied(false); }
  }
  return <div className="settings-page">
    <nav className="settings-nav" aria-label="Settings sections">{sections.map(([name, icon]) => <button key={name} className={`sidebar-item ${section === name ? 'active' : ''}`} aria-current={section === name ? 'page' : undefined} onClick={() => onSection(name)}><Icon name={icon} size={16} />{name}</button>)}</nav>
    <div className="settings-content">
      {section === 'Privacy' && <>
        <h1>Privacy</h1>
        <p className="lede">{recording ? 'What QuietNote does with your meetings.' : 'What QuietNote does with your meetings today, and what is still planned.'}</p>
        <section><h2>Active now</h2>
          {desktop ? fact('Stored on this device', `Meeting files live in a local archive on this computer. QuietNote uploads nothing unless you send action items to a service you connected${recording && values.summaryProvider === 'anthropic' ? ', or ask Claude for summary suggestions' : ''}.`) : fact('Stored in this browser', 'This browser preview keeps meetings in this browser’s local storage. Nothing is uploaded.')}
          {recording ? fact('Recording starts only when you choose', 'Nothing records automatically. QuietNote hears your microphone and what this computer plays, only while you record.') : fact('Capture starts only when you choose', 'Nothing begins capturing automatically.')}
          {recording && fact('Transcribed on this device', 'Audio and transcripts are made and kept on this computer with a bundled speech model. Nothing is uploaded.')}
          {fact('No meeting bot', 'QuietNote never joins a call or adds an attendee.')}
          {fact('No account required', 'There is no sign-in and no cloud sync.')}
          {desktop && fact(connected.length ? `Connected to ${connected.join(' and ')}` : 'No connections', connected.length ? 'Action items are sent only when you choose Send. Keys are kept in your macOS Keychain.' : 'Connect Linear or GitHub from Connections in the sidebar to send action items as issues.')}
          {detectsCalls && toggle('detectCalls', 'Offer to record calls', 'When Zoom, Teams, FaceTime, Slack or a browser starts using the microphone, a small panel offers to record. QuietNote only checks which app is using the microphone, on this Mac. Nothing records until you press Start recording.', true)}
          {desktop && mac && <div className="setting-row"><div><div className="setting-title">Use your calendar</div><p>Your meetings are named after their calendar events and know who’s invited; Home and the menu bar show what’s next, and People lists who you meet. QuietNote reads the calendars on this Mac (including Google and Outlook accounts added to it). It never changes them, never starts recording, and nothing is sent anywhere.</p>
            {calendarOn && (calendar === 'denied' || calendar === 'restricted') && <p className="field-error" role="alert">{calendar === 'restricted' ? 'Calendar access is restricted on this Mac.' : 'macOS hasn’t allowed QuietNote to read your calendar yet. Allow it under Privacy & Security → Calendars.'} {calendar === 'denied' && <button className="text-button" onClick={() => void openPrivacySettings('calendars').catch(() => { /* The message says where to go. */ })}>Open System Settings</button>}</p>}</div>
            <button type="button" className={`toggle ${calendarOn ? 'on' : ''}`} role="switch" aria-checked={calendarOn} aria-label="Use your calendar" onClick={() => {
              onChange('calendar', !calendarOn);
              if (!calendarOn) void calendarAccess(true).then(setCalendar).catch(() => setCalendar('denied'));
            }}><span /></button></div>}
          {detectsCalls && flag('detectCalls', true) && <div className="setting-row"><div><div className="setting-title">Recognize meetings in browsers</div><p>Offer to record a browser only while one of its windows or tabs is a meeting (Google Meet, Teams, Zoom, Webex, Whereby or Jitsi), and name it after the service. QuietNote reads the window and tab titles of the browser using the microphone, on this Mac, through macOS Accessibility. Nothing is kept or sent.</p>
            {confirming && allowed === false && <p className="field-error" role="alert">macOS hasn’t allowed this yet, so every browser using the microphone is still offered. Allow QuietNote under Privacy &amp; Security → Accessibility. <button className="text-button" onClick={() => void openPrivacySettings('accessibility').catch(() => { /* The message says where to go. */ })}>Open System Settings</button></p>}</div>
            <button type="button" className={`toggle ${confirming ? 'on' : ''}`} role="switch" aria-checked={confirming} aria-label="Recognize meetings in browsers" onClick={() => {
              onChange('confirmMeetings', !confirming);
              if (!confirming) void callAccessibility(true).then(setAllowed).catch(() => setAllowed(false));
            }}><span /></button></div>}
          {detectsCalls && flag('detectCalls', true) && muted.map(app => <div className="setting-row" key={`muted-${app}`}><div><div className="setting-title">Not offered for {app}</div><p>You chose not to be notified when {app} uses the microphone.</p></div><button className="text-button" onClick={() => onChange('mutedCallApps', muted.filter(a => a !== app))}>Notify again</button></div>)}
          {recording && liveTranscript && toggle('liveTranscript', 'Show the transcript while recording', 'Words appear a few seconds after they’re spoken, transcribed on this Mac; in English meetings, a faster model takes over and shows them about a second after. It’s a rough draft, and the full transcript is made again when you stop. While recording, it uses up to 1 GB more memory.', true)}
          {recording && mac && toggle('separateSpeakers', 'Tell the others apart', 'After you stop, the call audio is split by voice on this Mac, so the transcript shows Speaker 1, Speaker 2… instead of one “Others”. It groups voices by how they sound; it doesn’t identify anyone. It adds about two minutes per hour of audio.', true)}
          {recording && toggle('echoCancellation', 'Remove call audio from your microphone', 'On speakers, your microphone also hears the others. While recording, what this computer played is subtracted from your microphone track, so their words aren’t transcribed as yours and yours stay clearer when you talk at the same time. Turn it off if your own voice sounds cut off. Applies when you next start or resume recording.', true)}
          {recording && mac && toggle('pauseMedia', 'Pause music when recording starts', 'Music or a video playing on this Mac would be recorded too, so it’s paused when you start or resume recording. Nothing is started again afterwards.', true)}
          {recording && toggle('cleanTranscript', 'Remove filler words', 'Transcripts open in Clean view, without “um”, “uh” and repeated stutters. It changes how the transcript is shown, not what was recorded: Verbatim keeps the original transcription.', true)}
          {recording && toggle('deleteAudio', 'Delete audio after transcribing', 'Audio is deleted only after its transcript is saved, for meetings transcribed after you turn this on. Audio you already have is kept. If transcription fails, the audio is kept so you can retry. Deleted audio can’t be transcribed again.', false)}
        </section>
        {recording && desktop && <SummarySettings values={values} onChange={onChange} summaryKey={summaryKey} onSummaryKey={onSummaryKey} />}
        {!recording && <section className="planned-group"><h2>Planned <span className="badge">Not active yet</span></h2>
          <p className="group-note">These choices are saved for when audio capture and processing exist. They have no effect in this version.</p>
          {toggle('audio', 'Keep audio on this device', 'No audio files are created today.', true)}
          {toggle('deleteAudio', 'Delete audio after processing', 'No audio exists to delete, and no deletion runs.', false)}
          {toggle('local', 'Prefer on-device processing', 'Transcription isn’t implemented yet.', true)}
          {toggle('cloud', 'Allow cloud processing', 'Unavailable. No processing service is connected.', false, true)}
          <div className="setting-row"><div><div className="setting-title">Keep meeting data</div><p>Saved preference only. QuietNote never deletes files automatically.</p></div><select aria-label="Keep meeting data" value={String(values.retention ?? 'forever')} onChange={e => onChange('retention', e.target.value)}><option value="forever">Forever</option><option value="30">30 days</option><option value="7">7 days</option></select></div>
        </section>}
      </>}
      {section === 'Local archive' && <>
        <h1>Local archive</h1>
        <p className="lede">{desktop ? 'QuietNote stores meeting files in a local archive that you control. Each meeting is a folder of Markdown files you can open in any editor.' : 'This browser preview keeps meetings in this browser only. The desktop app stores them as Markdown files on your device.'}</p>
        <div className="button-row">{desktop && <button className="secondary" onClick={onOpenArchive}><Icon name="open" size={15} />Open archive</button>}<button className="secondary" onClick={onReload}><Icon name="refresh" size={15} />Reload from disk</button></div>
        <details className="advanced"><summary>Advanced</summary>
          {desktop && <div className="setting-row"><div><div className="setting-title">Location</div><p className="path">{root}</p></div><button className="text-button" onClick={() => void copyPath()}><Icon name="copy" size={15} />{copied ? 'Copied' : 'Copy path'}</button></div>}
          {desktop && mac && <div className="setting-row"><div><div className="setting-title">Command line</div><p>Read meetings in Terminal: <code>quietnote meetings</code>, <code>show</code>, <code>transcript</code> and <code>search</code>. It only reads the archive. To set it up, paste the copied command into Terminal; it asks for your password to link QuietNote into /usr/local/bin.</p>{cli === 'failed' && <p className="field-error" role="alert">Couldn’t copy the command.</p>}</div><button className="text-button" onClick={() => void copyCli()}><Icon name="copy" size={15} />{cli === 'copied' ? 'Copied' : 'Copy setup command'}</button></div>}
          {desktop && <div className="setting-row"><div><div className="setting-title">Use with AI apps (MCP)</div><p>Lets Claude Desktop, Claude Code or another MCP app read your meetings: list, search, notes and transcripts. It can’t change anything, and it runs only while that app uses it. What that app sends to its own servers is up to that app. Paste the copied configuration into its MCP settings.</p>{mcp === 'failed' && <p className="field-error" role="alert">Couldn’t copy the configuration.</p>}</div><button className="text-button" onClick={() => void copyMcp()}><Icon name="copy" size={15} />{mcp === 'copied' ? 'Copied' : 'Copy configuration'}</button></div>}
          <div className="setting-row"><div><div className="setting-title">Markdown workspace</div><p>Browse and edit the archive’s files in the full Scratch editor.</p></div><button className="text-button" disabled={!desktop} onClick={onWorkspace}>{desktop ? 'Open' : 'Desktop only'}</button></div>
          {!hasAllExamples && <div className="setting-row"><div><div className="setting-title">Example meetings</div><p>Add six illustrative meetings, marked Example, to see a finished workspace.</p></div><button className="text-button" onClick={onExamples}>Add examples</button></div>}
        </details>
      </>}
      {section === 'About' && <>
        <h1>About</h1>
        <p className="lede">QuietNote 0.1.0 <span className="badge">Prototype</span></p>
        <p className="body-copy">Built on <a href="https://github.com/erictli/scratch" target="_blank" rel="noreferrer">Scratch by Eric Li</a>, licensed under MIT. The original editor and local-file foundation are preserved.</p>
        {recording && <p className="body-copy">Transcription uses <a href="https://github.com/ggml-org/whisper.cpp" target="_blank" rel="noreferrer">whisper.cpp</a> (MIT) with OpenAI’s Whisper large-v3-turbo model (MIT) and the Silero voice activity detector (MIT), all running on this device. Echo cancellation is WebRTC’s AEC3, through <a href="https://github.com/dignifiedquire/sonora" target="_blank" rel="noreferrer">Sonora</a> (BSD-3-Clause).</p>}
        {recording && mac && <p className="body-copy">Voices are told apart, and English live transcripts are made, with <a href="https://github.com/k2-fsa/sherpa-onnx" target="_blank" rel="noreferrer">sherpa-onnx</a> (Apache-2.0) and ONNX Runtime (MIT), using pyannote segmentation 3.0 (MIT), 3D-Speaker ERes2Net (Apache-2.0) and NVIDIA’s Parakeet TDT 110M (CC BY 4.0).</p>}
        <p className="body-copy">Service logos in Connections come from Iconify “logos” (CC0), vscode-icons (MIT) and Simple Icons (CC0). Trademarks belong to their owners. Apple and Things icons are read from apps installed on this Mac.</p>
        <details className="advanced"><summary>MIT license & attribution</summary><div className="body-copy"><p>Copyright (c) Eric Li and Scratch contributors.</p><p>Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:</p><p>The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.</p><p>THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.</p></div></details>
      </>}
    </div>
  </div>;
}
