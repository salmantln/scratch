import { device, type PrivacyPreferences } from './storage';

/** Shortcuts as Tauri accelerators ("CmdOrCtrl+Shift+R"), so the one that works from any app can be handed to Rust as is.
 * CmdOrCtrl is ⌘ on a Mac and Ctrl elsewhere; Control is ⌃ on a Mac. */
export type Action = 'record' | 'newMeeting' | 'search' | 'settings' | 'sidebar';
export const actions: { action: Action; name: string; key: string; fallback: string }[] = [
  { action: 'record', name: 'Start recording', key: 'keyRecord', fallback: 'CmdOrCtrl+Shift+R' },
  { action: 'newMeeting', name: 'New meeting', key: 'keyNewMeeting', fallback: 'CmdOrCtrl+N' },
  { action: 'search', name: 'Search', key: 'keySearch', fallback: 'CmdOrCtrl+K' },
  { action: 'settings', name: 'Settings', key: 'keySettings', fallback: 'CmdOrCtrl+Comma' },
  { action: 'sidebar', name: 'Show or hide the sidebar', key: 'keySidebar', fallback: 'CmdOrCtrl+Backslash' },
];
/** Start recording from any app (`globalRecord`): unset is ⌃⌥R, empty is off. Registered by Rust (`hotkey.rs`). */
export const globalDefault = 'Control+Alt+R';
export const globalRecord = (values: PrivacyPreferences) => typeof values.globalRecord === 'string' ? values.globalRecord : globalDefault;
export const bound = (values: PrivacyPreferences, action: Action) => {
  const { key, fallback } = actions.find(a => a.action === action)!;
  return typeof values[key] === 'string' && values[key] ? values[key] as string : fallback;
};
/** Always the same: search's and the sidebar's other keys, projects, Markdown source mode, and what the editor and the window use. */
export const fixed = ['CmdOrCtrl+P', 'CmdOrCtrl+Shift+F', 'CmdOrCtrl+Shift+Enter', 'CmdOrCtrl+Shift+M', ...'123456789'.split('').map(n => `CmdOrCtrl+${n}`)];
const taken = [...fixed, ...['A', 'B', 'C', 'F', 'H', 'I', 'M', 'Q', 'S', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Shift+Z'].map(k => `CmdOrCtrl+${k}`)];

const mac = device === 'Mac';
const keys = /^(F\d{1,2}|Enter|Space|Tab|Backspace|Delete|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown|Comma|Period|Slash|Backslash|Semicolon|Quote|BracketLeft|BracketRight|Minus|Equal|Backquote)$/;
/** The key by where it is, not what it types, so ⌥R is still R on a Mac. */
function keyOf(code: string) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (code === 'NumpadEnter') return 'Enter';
  return keys.test(code) ? code : null;
}
/** What was pressed, as an accelerator; null for a modifier on its own. */
export function accelerator(event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>) {
  const key = keyOf(event.code);
  if (!key) return null;
  const command = mac ? event.metaKey : event.ctrlKey;
  return [command && 'CmdOrCtrl', !mac && event.metaKey && 'Super', mac && event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+');
}
const symbols: Record<string, string> = { Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: '\'', BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
/** As this computer writes it: ⌃⌥⇧⌘R on a Mac, Ctrl+Alt+Shift+R elsewhere. */
export function label(accel: string) {
  const parts = accel.split('+');
  const key = parts[parts.length - 1];
  const name = symbols[key] ?? (mac && key === 'Enter' ? '↩' : key);
  const has = (m: string) => parts.slice(0, -1).includes(m);
  if (mac) return [has('Control') && '⌃', has('Alt') && '⌥', has('Shift') && '⇧', (has('CmdOrCtrl') || has('Super')) && '⌘', name].filter(Boolean).join('');
  return [(has('CmdOrCtrl') || has('Control')) && 'Ctrl', has('Super') && 'Win', has('Alt') && 'Alt', has('Shift') && 'Shift', name].filter(Boolean).join('+');
}
const modifiers = (accel: string) => accel.split('+').slice(0, -1);
/** Why a shortcut can't be used for `action` (`'global'`: from any app), or '' when it can. */
export function problem(accel: string, action: Action | 'global', values: PrivacyPreferences) {
  const held = modifiers(accel);
  if (action === 'global' && held.length < 2) return `Use at least two of ${mac ? '⌃, ⌥, ⇧ and ⌘' : 'Ctrl, Alt, Shift and Win'}, so other apps keep their shortcuts.`;
  if (action !== 'global' && !held.some(m => m === 'CmdOrCtrl' || m === 'Control')) return `Include ${mac ? '⌘ or ⌃' : 'Ctrl'}, so typing never sets it off.`;
  if (taken.includes(accel)) return `${label(accel)} is already used by QuietNote or the editor.`;
  const other = actions.find(a => a.action !== action && bound(values, a.action) === accel);
  if (other) return `${label(accel)} is already the shortcut for ${other.name}.`;
  if (action !== 'global' && globalRecord(values) === accel) return `${label(accel)} already starts recording from any app.`;
  return '';
}
