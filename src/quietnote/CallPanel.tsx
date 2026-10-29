import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Menu } from '@tauri-apps/api/menu';
import { Icon, Logo } from './Icon';
import { Hush, showHush } from './Hush';
import { stopsIn } from './model';
import type { CalendarEvent } from './model';
import { appearance, type Appearance, type CaptureState, type PrivacyPreferences } from './storage';
import './quietnote.css';
type Ending = NonNullable<NonNullable<CaptureState['recording']>['ending']>;
/** The "Meeting detected" panel Rust shows when a call app starts using the microphone (see calls.rs). The same
 * panel counts down when a recording is about to stop by itself, so that's seen over the call too. */
export default function CallPanel() {
  const [app, setApp] = useState(() => new URLSearchParams(location.search).get('app') || 'A call');
  const [ending, setEnding] = useState<Ending | null>(null);
  // With the calendar on, the event this call probably is ("Weekly sync"), which the meeting will be named after.
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const lookUp = () => { invoke<CalendarEvent | null>('calendar_now').then(setEvent).catch(() => setEvent(null)); };
  const [now, setNow] = useState(() => Date.now());
  const [theme, setTheme] = useState<Appearance>('system');
  useEffect(() => {
    let cancelled = false; const unlisten: (() => void)[] = [];
    const track = (fn: () => void) => { if (cancelled) fn(); else unlisten.push(fn); };
    listen<string>('quietnote://call', e => { setApp(e.payload); setEnding(null); lookUp(); }).then(track);
    lookUp();
    // Show Hush and the theme, read again whenever Settings saves the preferences.
    const prefer = () => { invoke<PrivacyPreferences>('quietnote_preferences', { value: null }).then(p => { showHush(p.showHush !== false); setTheme(appearance(p)); }).catch(() => { /* Hush and the theme stay. */ }); };
    listen('quietnote://preferences-changed', prefer).then(track);
    prefer();
    listen<CaptureState>('quietnote://capture-state', e => setEnding(e.payload.recording?.ending ?? null)).then(track);
    invoke<CaptureState>('capture_status').then(s => { if (!cancelled) setEnding(s.recording?.ending ?? null); }).catch(() => { /* The next state update brings it. */ });
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') void invoke('call_dismiss'); };
    window.addEventListener('keydown', escape);
    return () => { cancelled = true; unlisten.forEach(fn => fn()); window.removeEventListener('keydown', escape); };
  }, []);
  // This window has no ThemeProvider, so it sets Scratch's `.dark` itself, following the computer for System.
  useEffect(() => {
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && system.matches));
    apply(); system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    if (!ending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [ending]);
  async function more() {
    const menu = await Menu.new({ items: [
      { id: 'open', text: 'Open QuietNote', action: () => void invoke('call_open', { settings: false }) },
      { item: 'Separator' },
      { id: 'mute', text: `Don’t notify for ${app}`, action: () => void invoke('call_mute') },
      { id: 'settings', text: 'Call detection settings…', action: () => void invoke('call_open', { settings: true }) },
    ] });
    await menu.popup();
  }
  if (ending) {
    return <div className="quietnote-shell call-panel ending" role="dialog" aria-label="Recording stops soon">
      <Hush mood="winding" size={36} fallback={<Logo size={20} />} />
      <div className="call-text"><strong>{stopsIn(ending.stopsAt, now)}</strong><span>{ending.reason}</span></div>
      <div className="call-actions">
        <button className="text-button" onClick={() => void invoke('capture_stop')}>Stop</button>
        <button className="primary" onClick={() => void invoke('capture_keep')}>Keep recording</button>
      </div>
    </div>;
  }
  return <div className="quietnote-shell call-panel" role="dialog" aria-label="Meeting detected">
    <button className="icon-button small call-dismiss" aria-label="Dismiss" onClick={() => void invoke('call_dismiss')}><Icon name="close" size={10} /></button>
    <Hush mood="ready" size={36} fallback={<Logo size={20} />} />
    <div className="call-text"><strong>{event ? event.title : 'Meeting detected'}</strong><span>{event ? `${app} · from your calendar` : app}</span></div>
    <div className="call-actions">
      <button className="primary" onClick={() => void invoke('call_record')}><span className="record-dot" />Record</button>
      <button className="icon-button call-more" aria-label="More options" onClick={() => void more()}><Icon name="chevron" size={13} /></button>
    </div>
  </div>;
}
