import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Hush } from './Hush';
import { device, desktop, enhanceNotes, meetingNames, noteTemplates, openTemplates, suggestSummary, type Cited, type Enhanced, type Names, type NoteTemplate, type Suggestions } from './storage';
import { actionItems, appendAction, clock, madeUp, notesMarkdown, replaceSection, section, templateFor, transcriptTurns, type Meeting } from './model';
/** Who drafts suggestions: Claude with the user's own key, or a model in Ollama on this computer. */
export type Summarizer = { local: boolean; label: string };
// Words, not Markdown marks ("-", "##").
const count = (text: string) => text.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
/** Suggestions drafted from a recorded transcript, and enhanced notes drafted from the user's notes and the
 * transcript under a template. Nothing is written until the user accepts, each line shows what it came
 * from, and asking first says exactly what leaves the device. */
export function SuggestPanel({ meeting, summarizer, template: preferred = '', onMarkdown, onRename, onSpeaker, onCite, onWorking, onAdded }: {
  meeting: Meeting; summarizer: Summarizer; template?: string; onMarkdown: (markdown: string) => Promise<void>; onRename: (title: string) => Promise<void>;
  onSpeaker: (from: string, to: string) => Promise<void>; onCite: (atMs: number) => void; onWorking?: (working: boolean) => void;
  /** The index of an action item just added from a suggestion, so the list can show where it went. */
  onAdded?: (index: number) => void;
}) {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'confirm-notes' | 'confirm-names' | 'working' | 'working-notes' | 'working-names'>('idle');
  // While a request is out, its notice has the meeting's Hush.
  useEffect(() => onWorking?.(phase.startsWith('working')), [phase, onWorking]);
  const [names, setNames] = useState<Names | null>(null);
  const [error, setError] = useState('');
  const [found, setFound] = useState<Suggestions | null>(null);
  const [enhanced, setEnhanced] = useState<Enhanced | null>(null);
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [template, setTemplate] = useState('');
  // Set when a draft came back with nothing that traces to the transcript.
  const [untraced, setUntraced] = useState<number | null>(null);
  const { markdown, metadata } = meeting;
  const who = summarizer.local ? `${summarizer.label} in Ollama` : 'Claude';
  const words = transcriptTurns(meeting.transcript).reduce((n, t) => n + count(t.text), 0);
  const notes = count(section(markdown, 'Notes'));
  // Worth asking for names when the title is one QuietNote made up, or voices are still unnamed.
  const unnamed = new Set(transcriptTurns(meeting.transcript).map(t => t.speaker).filter(v => /^(Others|Speaker \d+)$/.test(v)));
  const invited = (metadata.attendees ?? []).filter(a => !a.me).length || metadata.participants.length;
  // Templates can change in their folder, so they're read each time enhancing is asked for.
  useEffect(() => {
    if (phase !== 'confirm-notes') return;
    let cancelled = false;
    noteTemplates().then(list => { if (cancelled) return; setTemplates(list); setTemplate(t => list.some(l => l.name === t) ? t : templateFor(metadata.title, list.map(l => l.name), preferred)); }).catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [phase, metadata.title, preferred]);
  async function run() {
    setPhase('working'); setError(''); setUntraced(null);
    try {
      const s = await suggestSummary(metadata.id);
      if (s.summary || s.actions.length) setFound(s); else { setFound(null); setUntraced(s.dropped); }
    } catch (e) { setError(String(e)); }
    setPhase('idle');
  }
  async function enhance() {
    setPhase('working-notes'); setError(''); setUntraced(null);
    try {
      const e = await enhanceNotes(metadata.id, template);
      if (e.sections.length) setEnhanced(e); else { setEnhanced(null); setUntraced(e.dropped); }
    } catch (e) { setError(String(e)); }
    setPhase('idle');
  }
  async function name() {
    setPhase('working-names'); setError(''); setUntraced(null);
    try {
      const n = await meetingNames(metadata.id);
      const useful = { ...n, title: n.title && n.title !== metadata.title ? n.title : '' };
      if (useful.title || useful.speakers.length) setNames(useful); else { setNames(null); setUntraced(n.dropped); }
    } catch (e) { setError(String(e)); }
    setPhase('idle');
  }
  const useName = (run: Promise<void>, done: (n: Names) => Names) => run.then(() => setNames(n => { const next = n && done(n); return next && (next.title || next.speakers.length) ? next : null; })).catch(e => setError(String(e)));
  const drop = (item: Cited) => setFound(f => f && { ...f, actions: f.actions.filter(i => i !== item) });
  const accept = async (item: Cited) => {
    const index = actionItems(markdown).length;
    await onMarkdown(appendAction(markdown, item.owner ? `${item.owner} — ${item.text}` : item.text));
    onAdded?.(index);
    drop(item);
  };
  const cite = (atMs: number, quote: string) => <button className="citation" title="Show this line in the transcript" onClick={() => onCite(atMs)}><span className="timestamp">{clock(atMs / 1000)}</span>“{quote}”</button>;
  const row = (item: Cited, i: number) => <li key={i}>
    <div><span className="suggestion-text">{item.text}</span>{item.owner && <span className="action-owner">{item.owner}</span>}{cite(item.atMs, item.quote)}</div>
    <div className="suggestion-actions"><button className="text-button" onClick={() => void accept(item)}>Add</button><button className="text-button" aria-label={`Dismiss “${item.text}”`} onClick={() => drop(item)}>Dismiss</button></div>
  </li>;
  const replaces = section(markdown, 'Summary') ? 'Replace enhanced notes' : 'Use in enhanced notes';
  const usesNotes = section(markdown, 'Summary') ? 'Replace enhanced notes' : 'Use these notes';
  if (phase === 'confirm') return <div className="notice" role="dialog" aria-label="Suggest from transcript"><Icon name="info" size={16} /><div>
    <strong>{summarizer.local ? `Draft suggestions with ${who}?` : 'Send this transcript to Anthropic?'}</strong>
    <p>{summarizer.local ? `It runs on this ${device}, so nothing leaves it. It can take a minute or more, and small models miss or invent details more often.` : `About ${words.toLocaleString('en-GB')} words of transcript text go to Claude with your key. The audio, your notes and the meeting’s title stay on this ${device}.`}</p>
  </div><div className="notice-actions"><button className="text-button" onClick={() => setPhase('idle')}>Cancel</button><button className="primary" onClick={() => void run()}>{summarizer.local ? 'Draft suggestions' : 'Send transcript'}</button></div></div>;
  if (phase === 'confirm-notes') return <div className="notice" role="dialog" aria-label="Enhance notes"><Icon name="info" size={16} /><div>
    <strong>{summarizer.local ? `Enhance your notes with ${who}?` : 'Send your notes and this transcript to Anthropic?'}</strong>
    <p>Your notes are written up under the template’s sections and filled in from the transcript; every line quotes your notes or the transcript. {summarizer.local ? `It runs on this ${device}, so nothing leaves it.` : `${notes ? `Your notes (${notes.toLocaleString('en-GB')} words) and about` : 'About'} ${words.toLocaleString('en-GB')} words of transcript text go to Claude with your key. The audio and the meeting’s title stay on this ${device}.`}</p>
    <div className="template-row"><label>Template <select aria-label="Template" value={template} onChange={e => setTemplate(e.target.value)}>{templates.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}</select></label>
      {desktop && <button className="text-button" onClick={() => void openTemplates().catch(e => setError(String(e)))}>Edit templates</button>}</div>
    {templates.find(t => t.name === template) && <p className="subtle">{templates.find(t => t.name === template)!.sections.map(s => s.heading).join(' · ')}</p>}
  </div><div className="notice-actions"><button className="text-button" onClick={() => setPhase('idle')}>Cancel</button><button className="primary" disabled={!template} onClick={() => void enhance()}>{summarizer.local ? 'Enhance notes' : 'Send notes and transcript'}</button></div></div>;
  if (phase === 'confirm-names') return <div className="notice" role="dialog" aria-label="Name the meeting and speakers"><Icon name="info" size={16} /><div>
    <strong>{summarizer.local ? `Suggest a title and names with ${who}?` : 'Send this transcript to Anthropic for a title and names?'}</strong>
    <p>A voice is named only from a line that shows who it is (someone introducing themselves, or being addressed by name). {summarizer.local ? `It runs on this ${device}, so nothing leaves it.` : `About ${words.toLocaleString('en-GB')} words of transcript text${invited ? ` and the ${invited === 1 ? 'name of the person' : `names of the ${invited} people`} invited` : ''} go to Claude with your key. The audio, your notes and the meeting’s title stay on this ${device}.`}</p>
  </div><div className="notice-actions"><button className="text-button" onClick={() => setPhase('idle')}>Cancel</button><button className="primary" onClick={() => void name()}>{summarizer.local ? 'Suggest names' : 'Send transcript'}</button></div></div>;
  if (phase === 'working' || phase === 'working-notes' || phase === 'working-names') return <div className="notice" role="status"><Hush mood="suggesting" size={44} /><div><strong>{phase === 'working' ? `Drafting suggestions with ${who}…` : phase === 'working-names' ? `Looking for a title and names with ${who}…` : `Enhancing your notes with ${who}…`}</strong><p>You can keep working. Nothing is saved until you add it.</p></div></div>;
  const open = found && (found.summary || found.actions.length);
  const asks = <div className="suggest-row">
    <button className="text-button" onClick={() => setPhase('confirm-notes')}><Icon name="meeting" size={15} />Enhance notes…</button>
    <button className="text-button" onClick={() => setPhase('confirm')}><Icon name="task" size={15} />Suggest from transcript…</button>
    {(madeUp(metadata.title) || unnamed.size > 0) && <button className="text-button" onClick={() => setPhase('confirm-names')}><Icon name="people" size={15} />Name the meeting and speakers…</button>}
  </div>;
  const left = (dropped: number) => dropped > 0 && <p className="subtle">{dropped === 1 ? 'One more was' : `${dropped} more were`} left out because {dropped === 1 ? 'it' : 'they'} couldn’t be traced to your notes or the transcript.</p>;
  return <>
    {error && <div className="notice attention" role="alert"><Icon name="info" size={16} /><div><strong>That couldn’t be drafted.</strong><p>{error.replace(/^Error: /, '')}</p></div><div className="notice-actions"><button className="text-button" onClick={() => setError('')}>Dismiss</button></div></div>}
    {names && <section className="suggestions" aria-label="Names">
      <header><div><h2>Title and names</h2><p className="subtle">Suggested by {who}. Each name shows the line it came from; nothing changes until you use it.</p></div><button className="text-button" onClick={() => setNames(null)}>Dismiss</button></header>
      <ul className="suggestion-list">
        {names.title && <li><div><span className="suggestion-text">Title: {names.title}</span></div><div className="suggestion-actions"><button className="text-button" onClick={() => void useName(onRename(names.title), n => ({ ...n, title: '' }))}>Use</button><button className="text-button" onClick={() => setNames(n => n && { ...n, title: '' })}>Dismiss</button></div></li>}
        {names.speakers.map(s => <li key={s.speaker}><div><span className="suggestion-text">{s.speaker} is {s.name}</span>{cite(s.atMs, s.quote)}</div>
          <div className="suggestion-actions"><button className="text-button" onClick={() => void useName(onSpeaker(s.speaker, s.name), n => ({ ...n, speakers: n.speakers.filter(x => x !== s) }))}>Use</button><button className="text-button" aria-label={`Dismiss ${s.name}`} onClick={() => setNames(n => n && { ...n, speakers: n.speakers.filter(x => x !== s) })}>Dismiss</button></div></li>)}
      </ul>
      {left(names.dropped)}
    </section>}
    {enhanced && <section className="suggestions" aria-label="Enhanced notes">
      <header><div><h2>Enhanced notes</h2><p className="subtle">Drafted by {who} with the {template} template. Lines with a time come from the transcript; the rest from your notes. Nothing is saved until you use it.</p></div><button className="text-button" onClick={() => setEnhanced(null)}>Dismiss</button></header>
      {enhanced.sections.map(s => <div key={s.heading}><h3>{s.heading}</h3><ul className="suggestion-list">{s.lines.map((l, i) => <li key={i}><div><span className="suggestion-text">{l.text}</span>{l.atMs === null ? <span className="citation from-notes">From your notes: “{l.quote}”</span> : cite(l.atMs, l.quote)}</div></li>)}</ul></div>)}
      {left(enhanced.dropped)}
      <div className="suggestion-actions"><button className="text-button" onClick={() => void onMarkdown(replaceSection(markdown, 'Summary', notesMarkdown(enhanced.sections))).then(() => setEnhanced(null))}>{usesNotes}</button></div>
    </section>}
    {open ? <section className="suggestions" aria-label="Suggestions">
      <header><div><h2>Suggestions</h2><p className="subtle">Drafted by {who} from the transcript. Check each one: nothing is saved until you add it.</p></div><button className="text-button" onClick={() => setFound(null)}>Dismiss all</button></header>
      {found.summary && <div className="suggestion-summary"><p>{found.summary}</p><div className="suggestion-actions">
        <button className="text-button" onClick={() => void onMarkdown(replaceSection(markdown, 'Summary', found.summary)).then(() => setFound(f => f && { ...f, summary: '' }))}>{replaces}</button>
        <button className="text-button" onClick={() => setFound(f => f && { ...f, summary: '' })}>Dismiss</button></div></div>}
      {found.actions.length > 0 && <><h3>Action items</h3><ul className="suggestion-list">{found.actions.map(row)}</ul></>}
      {left(found.dropped)}
    </section>
    : untraced !== null ? <p className="subtle suggest-row">{untraced ? `Nothing could be traced to your notes or the transcript, so ${untraced === 1 ? 'the one line was' : `all ${untraced} lines were`} left out.` : `${who} found nothing to add.`}</p>
    : null}
    {!enhanced && !open && !names && asks}
  </>;
}
