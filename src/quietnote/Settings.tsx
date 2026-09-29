import { useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Icon } from './Icon';
import { desktop, type PrivacyPreferences } from './storage';
export type SettingsSection = 'Privacy' | 'Local archive' | 'About';
const sections: [SettingsSection, 'privacy' | 'archive' | 'info'][] = [['Privacy', 'privacy'], ['Local archive', 'archive'], ['About', 'info']];
export function Settings({ section, onSection, values, onChange, root, hasAllExamples, onOpenArchive, onReload, onWorkspace, onExamples }: {
  section: SettingsSection; onSection: (section: SettingsSection) => void; values: PrivacyPreferences; onChange: (key: string, value: boolean | string) => void; root: string; hasAllExamples: boolean;
  onOpenArchive: () => void; onReload: () => void; onWorkspace: () => void; onExamples: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const flag = (key: string, fallback: boolean) => typeof values[key] === 'boolean' ? values[key] as boolean : fallback;
  function toggle(key: string, title: string, description: string, fallback: boolean, disabled = false) {
    const checked = flag(key, fallback);
    return <div className="setting-row" key={key}><div><div className="setting-title">{title}</div><p>{description}</p></div><button type="button" className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} aria-label={title} disabled={disabled} onClick={() => onChange(key, !checked)}><span /></button></div>;
  }
  const fact = (title: string, description: string) => <div className="setting-row fact" key={title}><Icon name="check" size={16} /><div><div className="setting-title">{title}</div><p>{description}</p></div></div>;
  async function copyPath() {
    try { if (desktop) await writeText(root); else await navigator.clipboard.writeText(root); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { setCopied(false); }
  }
  return <div className="settings-page">
    <nav className="settings-nav" aria-label="Settings sections">{sections.map(([name, icon]) => <button key={name} className={`sidebar-item ${section === name ? 'active' : ''}`} aria-current={section === name ? 'page' : undefined} onClick={() => onSection(name)}><Icon name={icon} size={16} />{name}</button>)}</nav>
    <div className="settings-content">
      {section === 'Privacy' && <>
        <h1>Privacy</h1>
        <p className="lede">What QuietNote does with your meetings today, and what is still planned.</p>
        <section><h2>Active now</h2>
          {desktop ? fact('Stored on this device', 'Meeting files live in a local archive on this computer. QuietNote doesn’t upload meeting content.') : fact('Stored in this browser', 'This browser preview keeps meetings in this browser’s local storage. Nothing is uploaded.')}
          {fact('Capture starts only when you choose', 'Nothing begins capturing automatically.')}
          {fact('No meeting bot', 'QuietNote never joins a call or adds an attendee.')}
          {fact('No account required', 'There is no sign-in and no cloud sync.')}
          {toggle('confirm', 'Confirm before capture', 'Open the capture panel first instead of starting straight away.', true)}
        </section>
        <section className="planned-group"><h2>Planned <span className="badge">Not active yet</span></h2>
          <p className="group-note">These choices are saved for when audio capture and processing exist. They have no effect in this version.</p>
          {toggle('audio', 'Keep audio on this device', 'No audio files are created today.', true)}
          {toggle('deleteAudio', 'Delete audio after processing', 'No audio exists to delete, and no deletion runs.', false)}
          {toggle('local', 'Prefer on-device processing', 'Transcription isn’t implemented yet.', true)}
          {toggle('cloud', 'Allow cloud processing', 'Unavailable. No processing service is connected.', false, true)}
          <div className="setting-row"><div><div className="setting-title">Keep meeting data</div><p>Saved preference only. QuietNote never deletes files automatically.</p></div><select aria-label="Keep meeting data" value={String(values.retention ?? 'forever')} onChange={e => onChange('retention', e.target.value)}><option value="forever">Forever</option><option value="30">30 days</option><option value="7">7 days</option></select></div>
        </section>
      </>}
      {section === 'Local archive' && <>
        <h1>Local archive</h1>
        <p className="lede">{desktop ? 'QuietNote stores meeting files in a local archive that you control. Each meeting is a folder of Markdown files you can open in any editor.' : 'This browser preview keeps meetings in this browser only. The desktop app stores them as Markdown files on your device.'}</p>
        <div className="button-row">{desktop && <button className="secondary" onClick={onOpenArchive}><Icon name="open" size={15} />Open archive</button>}<button className="secondary" onClick={onReload}><Icon name="refresh" size={15} />Reload from disk</button></div>
        <details className="advanced"><summary>Advanced</summary>
          {desktop && <div className="setting-row"><div><div className="setting-title">Location</div><p className="path">{root}</p></div><button className="text-button" onClick={() => void copyPath()}><Icon name="copy" size={15} />{copied ? 'Copied' : 'Copy path'}</button></div>}
          <div className="setting-row"><div><div className="setting-title">Markdown workspace</div><p>Browse and edit the archive’s files in the full Scratch editor.</p></div><button className="text-button" disabled={!desktop} onClick={onWorkspace}>{desktop ? 'Open' : 'Desktop only'}</button></div>
          {!hasAllExamples && <div className="setting-row"><div><div className="setting-title">Example meetings</div><p>Add six illustrative meetings, marked Example, to see a finished workspace.</p></div><button className="text-button" onClick={onExamples}>Add examples</button></div>}
        </details>
      </>}
      {section === 'About' && <>
        <h1>About</h1>
        <p className="lede">QuietNote 0.1.0 <span className="badge">Prototype</span></p>
        <p className="body-copy">Built on <a href="https://github.com/erictli/scratch" target="_blank" rel="noreferrer">Scratch by Eric Li</a>, licensed under MIT. The original editor and local-file foundation are preserved.</p>
        <details className="advanced"><summary>MIT license & attribution</summary><div className="body-copy"><p>Copyright (c) Eric Li and Scratch contributors.</p><p>Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:</p><p>The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.</p><p>THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.</p></div></details>
      </>}
    </div>
  </div>;
}
