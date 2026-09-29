import { useEffect, useId, useRef, useState } from 'react';
import { Modal } from './Dialogs';
import { Icon } from './Icon';
import { categories, connectors, matchesConnector, serviceName, type Connector } from './catalog';
import { actionItems, issueFor, type Meeting } from './model';
import * as storage from './storage';
const message = (e: unknown) => String(e).replace(/^Error: /, '');
export function BrandMark({ connector: c, appIcon }: { connector: Connector; appIcon?: string }) {
  if (appIcon) return <img className="brand-mark app" src={appIcon} alt="" />;
  if (c.logo) return <span className="brand-mark logo" aria-hidden="true"><img src={c.logo} alt="" /></span>;
  return <span className="brand-mark" style={{ background: `#${c.color}` }} aria-hidden="true">{c.monogram}</span>;
}
function ConnectorRow({ connector: c, appIcon, account, onChange }: { connector: Connector; appIcon?: string; account?: { account: string }; onChange: (service: storage.Service, account?: { account: string }) => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (form) input.current?.focus(); }, [form]);
  async function connect(service: storage.Service) {
    setBusy(true); setError('');
    try { const connected = await storage.connect(service, token); setToken(''); setForm(false); onChange(service, connected); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  async function disconnect(service: storage.Service) {
    setBusy(true); setError('');
    try { await storage.disconnect(service); onChange(service); }
    catch (e) { setError(`Couldn’t disconnect ${c.name}. ${message(e)}`); setBusy(false); }
  }
  const action = !c.service ? <span className="badge">Planned</span>
    : account ? <button className="text-button" disabled={busy} onClick={() => void disconnect(c.service!)}>Disconnect</button>
    : !storage.desktop ? <button className="secondary" disabled>Desktop only</button>
    : !form && <button className="secondary" onClick={() => setForm(true)}>Connect</button>;
  return <li className={`connector ${form ? 'expanded' : ''}`}>
    <div className="connector-row"><BrandMark connector={c} appIcon={appIcon} /><div className="connector-text"><strong>{c.name}</strong><span>{account ? `Connected as ${account.account}` : c.blurb}</span></div>{action}</div>
    {form && c.service && c.setup && <form className="token-form" onSubmit={e => { e.preventDefault(); if (token.trim()) void connect(c.service!); }}>
      <p>{c.setup.hint} <button type="button" className="text-button" onClick={() => void storage.openLink(c.setup!.url)}>Create a key<Icon name="open" size={13} /></button></p>
      <div className="token-field">
        <label htmlFor={id} className="sr-only">{c.name} key</label>
        <input id={id} ref={input} type="password" autoComplete="off" spellCheck={false} placeholder="Paste your key" value={token} aria-invalid={Boolean(error)} onChange={e => { setToken(e.target.value); setError(''); }} />
        <button type="button" className="text-button" disabled={busy} onClick={() => { setForm(false); setToken(''); setError(''); }}>Cancel</button>
        <button type="submit" className="secondary" disabled={busy || !token.trim()}>{busy ? 'Checking…' : 'Connect'}</button>
      </div>
      <p className="connector-note">QuietNote checks the key with {c.name}, then keeps it in your macOS Keychain.</p>
    </form>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </li>;
}
export function ConnectionsDialog({ connections, onChange, onClose }: { connections: storage.Connections; onChange: (next: storage.Connections) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [appIcons, setAppIcons] = useState<Record<string, string>>({});
  useEffect(() => { storage.appIcons().then(setAppIcons).catch(() => { /* Letter tiles stand in. */ }); }, []);
  const shown = connectors.filter(c => matchesConnector(c, query));
  const isConnected = (c: Connector) => Boolean(c.service && connections[c.service]);
  const groups = [['Connected', shown.filter(isConnected)] as const, ...categories.map(name => [name, shown.filter(c => c.category === name && !isConnected(c))] as const)].filter(([, list]) => list.length);
  const change = (service: storage.Service, account?: { account: string }) => {
    const next = { ...connections };
    if (account) next[service] = account; else delete next[service];
    onChange(next);
  };
  return <Modal title="Connections" onEscape={onClose} className="wide connections">
    <p className="lede">Connect only the services you use. QuietNote never joins your calls, and nothing leaves this Mac until you choose to send it.</p>
    <label className="search-field"><Icon name="search" size={16} /><input type="search" data-autofocus aria-label="Search connections" placeholder="Search connections" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <div className="connector-groups">
      {groups.map(([name, list]) => <section key={name} aria-label={name}><h3>{name}</h3><ul>{list.map(c => <ConnectorRow key={c.id} connector={c} appIcon={c.app && appIcons[c.id]} account={c.service && connections[c.service]} onChange={change} />)}</ul></section>)}
      {!groups.length && <p className="subtle" role="status">No connections match “{query.trim()}”.</p>}
      <p className="connector-note directory-note">Planned services that need a sign-in will sign in through your browser and keep access on this Mac, never on a QuietNote server.</p>
    </div>
    <button className="icon-button modal-close" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
  </Modal>;
}
export type IssueLink = { index: number; label: string; url: string };
export function SendDialog({ meeting, connections, lastTargets, onSent, onClose }: {
  meeting: Meeting; connections: storage.Connections; lastTargets: Partial<Record<storage.Service, string>>;
  onSent: (service: storage.Service, target: string, links: IssueLink[]) => Promise<void>; onClose: () => void;
}) {
  const id = useId();
  const services = (['linear', 'github'] as const).filter(s => connections[s]);
  const [items] = useState(() => actionItems(meeting.markdown).filter(a => !a.done && !a.link));
  const [service, setService] = useState<storage.Service>(services[0]);
  const [targets, setTargets] = useState<storage.Target[] | null>(null);
  const [target, setTarget] = useState('');
  const [chosen, setChosen] = useState(() => new Set(items.map(a => a.index)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<{ text: string; sent: storage.Sent }[] | null>(null);
  const remembered = useRef(lastTargets);
  useEffect(() => {
    let cancelled = false;
    setTargets(null); setTarget(''); setError('');
    storage.connectorTargets(service).then(list => {
      if (cancelled) return;
      const saved = remembered.current[service];
      setTargets(list); setTarget(list.some(t => t.id === saved) ? saved! : list[0]?.id ?? '');
    }).catch(e => { if (!cancelled) { setTargets([]); setError(`Couldn’t load from ${serviceName(service)}. ${message(e)}`); } });
    return () => { cancelled = true; };
  }, [service]);
  const picked = items.filter(a => chosen.has(a.index));
  const kind = service === 'linear' ? 'Team' : 'Repository';
  async function send() {
    setBusy(true); setError('');
    try {
      const sent = await storage.sendIssues(service, target, picked.map(a => issueFor(a, meeting.metadata)));
      const links = picked.flatMap((a, i) => sent[i]?.label && sent[i]?.url ? [{ index: a.index, label: sent[i].label!, url: sent[i].url! }] : []);
      await onSent(service, target, links);
      setResults(picked.map((a, i) => ({ text: a.text, sent: sent[i] ?? { label: null, url: null, error: 'No response for this item.' } })));
    } catch (e) { setError(`Couldn’t send to ${serviceName(service)}. ${message(e)}`); }
    finally { setBusy(false); }
  }
  return <Modal title={results ? `Sent to ${serviceName(service)}` : 'Send action items'} onEscape={busy ? undefined : onClose} className="send-dialog">
    {results ? <>
      <ul className="send-results">{results.map((r, i) => <li key={i} className={r.sent.error ? 'failed' : ''}><Icon name={r.sent.error ? 'info' : 'check'} size={15} /><span><span className="action-text">{r.text}</span>
        {r.sent.error ? <span className="field-error">{r.sent.error}</span> : <button className="action-link" onClick={() => void storage.openLink(r.sent.url!)}>{r.sent.label}</button>}</span></li>)}</ul>
      <div className="modal-actions"><button className="primary" onClick={onClose}>Done</button></div>
    </> : <form onSubmit={e => { e.preventDefault(); if (target && picked.length) void send(); }}>
      {services.length > 1 && <div className="field"><label htmlFor={`${id}-service`}>Send to</label><select id={`${id}-service`} value={service} disabled={busy} onChange={e => setService(e.target.value as storage.Service)}>{services.map(s => <option key={s} value={s}>{serviceName(s)}</option>)}</select></div>}
      <div className="field"><label htmlFor={`${id}-target`}>{kind}</label><select id={`${id}-target`} value={target} disabled={busy || !targets?.length} onChange={e => setTarget(e.target.value)}>
        {targets === null ? <option value="">Loading…</option> : targets.length ? targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>) : <option value="">None available</option>}
      </select></div>
      {targets?.length === 0 && !error && <p className="connector-note">This key can’t see any {service === 'linear' ? 'teams' : 'repositories with issues'}.</p>}
      <fieldset className="send-items"><legend>Action items</legend>{items.map(a => <label key={a.index} className="send-item">
        <input type="checkbox" checked={chosen.has(a.index)} disabled={busy} onChange={() => setChosen(set => { const next = new Set(set); if (!next.delete(a.index)) next.add(a.index); return next; })} />
        <span><span className="action-text">{a.text}</span>{a.owner && <span className="action-owner">{a.owner}</span>}</span>
      </label>)}</fieldset>
      <p className="connector-note">Sends each item’s text and owner, plus this meeting’s title, date and project. Nothing else leaves this device.</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy || !target || !picked.length}>{busy ? 'Sending…' : `Create ${picked.length} ${picked.length === 1 ? 'issue' : 'issues'}`}</button></div>
    </form>}
  </Modal>;
}
