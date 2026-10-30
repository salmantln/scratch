import { useEffect, useState } from 'react';
import { Modal } from './Dialogs';
import { dateLabel } from './model';
import { activateLicense, checkLicense, checkout, licenseStatus, openLink, portal, removeLicense, type LicenseStatus } from './storage';

const message = (e: unknown) => String(e).replace(/^Error: /, '');
const day = (ms: number) => dateLabel(new Date(ms).toISOString());
/** What the subscription's state means for the user, in a title and one sentence. */
export function licenseText(status: LicenseStatus): { title: string; text: string } {
  const { state, license, locksAt } = status;
  if (state === 'active' && license) return { title: `Subscribed${license.name ? ` · ${license.name}` : ''}`, text: `${license.plan || 'QuietNote'}${license.renewsAt ? `, paid until ${dateLabel(license.renewsAt)}` : ''}. Checked with Lemon Squeezy once a day.` };
  if (state === 'offline' && license && locksAt) return status.mayRecord
    ? { title: 'Couldn’t check your subscription', text: `QuietNote last reached Lemon Squeezy on ${day(license.checkedAt)}. Recording keeps working until ${day(locksAt)}, and it checks again once you’re online.` }
    : { title: 'Couldn’t check your subscription', text: `QuietNote hasn’t reached Lemon Squeezy since ${day(license.checkedAt)}, so recording is off until it does. Connect to the internet and check again. Your meetings stay readable.` };
  if (state === 'ended') return license?.ended === 'disabled'
    ? { title: 'This license was disabled', text: 'Lemon Squeezy disabled this key, for example after a refund. Recording is off; your meetings, notes and transcripts stay readable and exportable.' }
    : { title: 'Your subscription has ended', text: 'Recording is off. Your meetings, notes and transcripts stay readable and exportable. Renew to record again.' };
  if (state === 'invalid') return { title: 'This license key no longer works', text: 'Lemon Squeezy doesn’t know this key or this Mac’s activation any more. Enter your key again to record.' };
  return { title: 'Subscribe to record', text: 'Recording needs a QuietNote subscription. Your meetings, notes and transcripts stay readable and exportable without one.' };
}
// Renewing goes to the customer portal, where the subscription is; without one, to the checkout.
const renew = portal ?? checkout;

/** The key field: activates the key, then hands back the new status. */
function LicenseKey({ onActivated, autoFocus = false }: { onActivated: (status: LicenseStatus) => void; autoFocus?: boolean }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function activate() {
    setBusy(true); setError('');
    try { onActivated(await activateLicense(key)); setKey(''); } catch (e) { setError(message(e)); }
    setBusy(false);
  }
  return <form className="setting-row key-row" onSubmit={e => { e.preventDefault(); if (key.trim()) void activate(); }}>
    <div className="setting-title">License key</div>
    <p>From your receipt email. It’s kept in your macOS Keychain. To activate and check it, QuietNote sends Lemon Squeezy only the key, this Mac’s activation ID and the name “QuietNote for Mac”.</p>
    <div className="token-field"><input aria-label="License key" placeholder="Paste your key" value={key} autoFocus={autoFocus} autoComplete="off" spellCheck={false} aria-invalid={Boolean(error)} onChange={e => { setKey(e.target.value); setError(''); }} />
      <button className="primary" type="submit" disabled={busy || !key.trim()}>{busy ? 'Checking…' : 'Activate'}</button></div>
    {error && <p className="field-error setting-error" role="alert">{error}</p>}
  </form>;
}

/** Shown instead of recording when the subscription doesn't allow it (none, ended, not checked for too long). */
export function LicenseDialog({ status, onActivated, onClose }: { status: LicenseStatus; onActivated: (status: LicenseStatus) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { title, text } = licenseText(status);
  // Offline too long: the key is fine, it only needs checking.
  const offline = status.state === 'offline';
  async function check() {
    setBusy(true); setError('');
    try { const next = await checkLicense(); if (next.mayRecord) onActivated(next); else setError(licenseText(next).text); } catch (e) { setError(message(e)); }
    setBusy(false);
  }
  const buy = status.state === 'ended' ? renew : checkout;
  return <Modal title={title} onEscape={onClose}>
    <p className="subtle">{text}</p>
    {offline ? error && <p className="field-error" role="alert">{error}</p> : <LicenseKey onActivated={onActivated} autoFocus />}
    <div className="modal-actions">
      <button type="button" className="secondary" onClick={onClose}>Cancel</button>
      {offline ? <button type="button" className="primary" disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Check now'}</button>
        : buy && <button type="button" className="secondary" onClick={() => void openLink(buy)}>{status.state === 'ended' ? 'Renew subscription' : 'Subscribe'}</button>}
    </div>
  </Modal>;
}

/** Settings → About: the subscription, what it allows, and its key. */
export function Subscription() {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [entering, setEntering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    let cancelled = false;
    licenseStatus().then(s => { if (!cancelled) setStatus(s); }).catch(e => { if (!cancelled) setError(message(e)); });
    return () => { cancelled = true; };
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNote('');
    try { await action(); } catch (e) { setError(message(e)); }
    setBusy(false);
  }
  const check = () => run(async () => setStatus(await checkLicense()));
  const remove = () => run(async () => { setNote(await removeLicense() ?? ''); setStatus(await licenseStatus()); });
  if (!status?.available) return error ? <p className="field-error" role="alert">{error}</p> : null;
  const { state, license } = status;
  const { title, text } = licenseText(status);
  const main = state === 'active' ? portal && <button className="secondary" onClick={() => void openLink(portal!)}>Manage subscription</button>
    : state === 'offline' ? <button className="secondary" disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Check now'}</button>
    : state === 'ended' && license?.ended === 'expired' ? renew && <button className="primary" onClick={() => void openLink(renew!)}>Renew subscription</button>
    : checkout && <button className="primary" onClick={() => void openLink(checkout!)}>Subscribe</button>;
  // A key is entered when there's none that works: none yet, or one that ended or is no longer known.
  const needsKey = state === 'none' || state === 'invalid' || state === 'ended';
  return <section><h2>Subscription</h2>
    <div className="setting-row"><div><div className="setting-title">{title}</div><p>{text}</p></div>{main}</div>
    {needsKey && (entering ? <LicenseKey onActivated={s => { setStatus(s); setEntering(false); }} autoFocus />
      : <div className="setting-row"><div><div className="setting-title">Already subscribed?</div><p>Enter the key from your receipt email.</p></div><button className="text-button" onClick={() => { setEntering(true); setNote(''); }}>Enter license key</button></div>)}
    {state === 'ended' && license?.ended === 'expired' && <div className="setting-row"><div><div className="setting-title">Renewed already?</div><p>QuietNote checks once a day; check now to record straight away.</p></div><button className="text-button" disabled={busy} onClick={() => void check()}>Check now</button></div>}
    {license && <div className="setting-row"><div><div className="setting-title">Remove from this Mac</div><p>Frees this Mac’s activation, to use the key on another one.</p></div><button className="text-button" disabled={busy} onClick={() => void remove()}>Remove license</button></div>}
    {error && <p className="field-error setting-error" role="alert">{error}</p>}
    {note && <p className="subtle">{note}</p>}
  </section>;
}
