import { lazy, Suspense, useCallback, useRef, useState } from 'react';
const Editor = lazy(() => import('../components/editor/Editor').then(module => ({ default: module.Editor })));
import { Icon } from './Icon';
import { actionItems, appendItem, dateLabel, decisions, durationLabel, meetingTabs, section, statusLabel, timeLabel, toggleAction, transcriptTurns, type Meeting, type MeetingTab } from './model';
function AddItem({ label, onAdd }: { label: string; onAdd: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  return <form className="add-item" onSubmit={e => { e.preventDefault(); if (text.trim()) void onAdd(text).then(() => setText('')); }}>
    <Icon name="plus" size={15} /><input aria-label={label} placeholder={label} value={text} maxLength={300} onChange={e => setText(e.target.value)} />
    {text.trim() && <button type="submit" className="text-button">Add</button>}
  </form>;
}
export function MeetingDetail({ meeting, example, tab, onTab, onMarkdown, onNotes, onDraft, onStartCapture, onMarkEnded }: {
  meeting: Meeting; example: boolean; tab: MeetingTab; onTab: (tab: MeetingTab) => void; onMarkdown: (markdown: string) => Promise<void>; onNotes: (notes: string) => Promise<void>; onDraft: (notes: string) => void; onStartCapture: () => void; onMarkEnded: () => void;
}) {
  const { metadata: meta, markdown, transcript } = meeting;
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const latestSave = useRef(onNotes); latestSave.current = onNotes;
  const save = useCallback((notes: string) => latestSave.current(notes), []);
  const summary = section(markdown, 'Summary');
  const agreed = decisions(markdown);
  const actions = actionItems(markdown);
  const open = actions.filter(a => !a.done);
  const turns = transcriptTurns(transcript);
  const shownTurns = turns.filter(t => `${t.speaker} ${t.text}`.toLowerCase().includes(transcriptQuery.toLowerCase()));
  const status = statusLabel(meta.status);
  const duration = durationLabel(meta.duration);
  const tabIds = (t: MeetingTab) => ({ tab: `tab-${t.replace(' ', '-')}`, panel: `panel-${t.replace(' ', '-')}` });
  const renderAction = (a: typeof actions[number]) => <label className={`action-row ${a.done ? 'complete' : ''}`} key={a.index}>
    <input type="checkbox" checked={a.done} onChange={() => void onMarkdown(toggleAction(markdown, a.index))} />
    <span><span className="action-text">{a.text}</span>{a.owner && <span className="action-owner">{a.owner}</span>}</span>
  </label>;
  return <article className="meeting-detail">
    <header className="meeting-header">
      <div className="meeting-title-row">
        <div className="meeting-title">
          <h1>{meta.title}{example && <span className="badge example">Example</span>}</h1>
          <p className="meeting-meta"><span>{meta.project}</span><span>{dateLabel(meta.date)}, {timeLabel(meta.date)}</span>{duration && <span>{duration}</span>}{status && <span className={`status ${meta.status}`}><i aria-hidden="true" />{status}</span>}{meta.participants.length > 0 && <span className="participants" title={meta.participants.join(', ')}>{meta.participants.join(', ')}</span>}</p>
        </div>
        {meta.status === 'idle' && <button className="secondary" onClick={onStartCapture}>Start capture</button>}
      </div>
      <div className="meeting-tabs" role="tablist" aria-label="Meeting sections" onKeyDown={e => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = meetingTabs[(meetingTabs.indexOf(tab) + step + meetingTabs.length) % meetingTabs.length];
        onTab(next); document.getElementById(tabIds(next).tab)?.focus();
      }}>{meetingTabs.map(t => <button key={t} id={tabIds(t).tab} role="tab" aria-selected={t === tab} aria-controls={tabIds(t).panel} tabIndex={t === tab ? 0 : -1} onClick={() => onTab(t)}>{t}{t === 'Action items' && open.length > 0 && <><span className="count" aria-hidden="true">{open.length}</span><span className="sr-only">, {open.length} open</span></>}</button>)}</div>
    </header>
    {meta.status === 'error' && <div className="notice attention" role="status"><Icon name="info" size={16} /><div><strong>This meeting was interrupted before it finished.</strong><p>QuietNote closed while capture was running. No audio was recorded. Anything you wrote in Notes is kept.</p></div><div className="notice-actions"><button className="text-button" onClick={() => onTab('Notes')}>Add notes</button><button className="text-button" onClick={onMarkEnded}>Mark as ended</button></div></div>}
    <div className="meeting-content" role="tabpanel" id={tabIds(tab).panel} aria-labelledby={tabIds(tab).tab}>
      {tab === 'Summary' && <>
        {summary ? <div className="summary-text">{summary.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div> : <div className="empty-inline"><h2>No summary yet.</h2><p>Automatic summaries aren’t available in this version. Your own notes are the record of this meeting.</p><button className="secondary" onClick={() => onTab('Notes')}>Add notes</button></div>}
        {agreed.length > 0 && <section className="summary-preview"><h2>Decisions</h2><ul className="decision-list">{agreed.slice(0, 3).map((d, i) => <li key={i}><Icon name="decision" size={16} />{d}</li>)}</ul>{agreed.length > 3 && <button className="text-button" onClick={() => onTab('Decisions')}>All {agreed.length} decisions<Icon name="arrow" size={14} /></button>}</section>}
        {actions.length > 0 && <section className="summary-preview"><h2>Action items</h2><button className="text-button" onClick={() => onTab('Action items')}>{open.length ? `${open.length} of ${actions.length} open` : `All ${actions.length} complete`}<Icon name="arrow" size={14} /></button></section>}
      </>}
      {tab === 'Decisions' && <section>
        {agreed.length ? <ul className="decision-list">{agreed.map((d, i) => <li key={i}><Icon name="decision" size={16} />{d}</li>)}</ul> : <div className="empty-inline"><h2>No decisions yet.</h2><p>Add what was agreed so it’s easy to find later.</p></div>}
        <AddItem label="Add a decision" onAdd={text => onMarkdown(appendItem(markdown, 'Decisions', text))} />
      </section>}
      {tab === 'Action items' && <section>
        {actions.length ? <div className="action-list">{actions.map(renderAction)}</div> : <div className="empty-inline"><h2>No action items yet.</h2><p>Add follow-ups as you go. Write “Maya — send the plan” to note an owner.</p></div>}
        <AddItem label="Add an action item" onAdd={text => onMarkdown(appendItem(markdown, 'Action items', text))} />
      </section>}
      {tab === 'Notes' && <div className="quiet-editor"><Suspense fallback={<p className="subtle">Opening notes…</p>}><Editor onDraftChange={onDraft} key={meta.id} previewMode={{ content: section(markdown, 'Notes'), title: 'Notes', filePath: meta.meetingPath, modified: 0, hasExternalChanges: false, reloadVersion: 0, save, reload: async () => {} }} /></Suspense></div>}
      {tab === 'Transcript' && <section>
        {turns.length ? <>
          <div className="transcript-tools">{example && <span className="subtle">Example transcript · illustrative, not a recording</span>}<label className="inline-search"><Icon name="search" size={15} /><input placeholder="Find in transcript" aria-label="Find in transcript" value={transcriptQuery} onChange={e => setTranscriptQuery(e.target.value)} /></label></div>
          {shownTurns.map((t, i) => <div className="transcript-turn" key={i}><h3>{t.speaker}<span className="timestamp">{t.time}</span></h3><p>{t.text}</p></div>)}
          {!shownTurns.length && <p className="subtle">Nothing in the transcript matches “{transcriptQuery}”.</p>}
        </> : <div className="empty-inline"><h2>Transcript unavailable.</h2><p>This version doesn’t transcribe audio.</p></div>}
      </section>}
    </div>
  </article>;
}
