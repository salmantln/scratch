import { lazy, Suspense, useCallback, useRef, useState } from 'react';
const Editor = lazy(() => import('../components/editor/Editor').then(module => ({ default: module.Editor }))); 
import { Icon } from './Icon';
import { dateLabel, durationLabel, section, toggleAction, type Meeting } from './model';
export type MeetingTab = 'Summary' | 'Decisions' | 'Action items' | 'Notes' | 'Transcript';
export function MeetingDetail({ meeting, tab, onTab, onMarkdown, onNotes, onDraft, onBack, onReview, review }: {
  meeting: Meeting; tab: MeetingTab; onTab: (tab: MeetingTab) => void; onMarkdown: (markdown: string) => Promise<void>; onNotes: (notes: string) => Promise<void>; onDraft: (notes: string) => void; onBack: () => void; onReview: () => void; review: boolean;
}) {
  const { metadata: meta, markdown, transcript } = meeting;
  const [transcriptQuery, setTranscriptQuery] = useState('');
  const latestSave = useRef(onNotes); latestSave.current = onNotes;
  const save = useCallback((notes: string) => latestSave.current(notes), []);
  const decisions = section(markdown, 'Decisions').split('\n').filter(l => /^[-*] /.test(l)).map(l => l.slice(2));
  const actions = section(markdown, 'Action items').split('\n').filter(l => /^- \[[ xX]\] /.test(l));
  const complete = actions.filter(l => /^- \[[xX]\]/.test(l)).length;
  const chunks = transcript.split(/^### /m).slice(1).filter(chunk => chunk.toLowerCase().includes(transcriptQuery.toLowerCase()));
  const renderDecisions = () => <section className="decisions-section"><div className="section-heading"><h2>Decisions</h2><span>{decisions.length} agreed</span></div>{decisions.length ? <ul>{decisions.map((decision, i) => <li key={i}><span className="decision-check"><Icon name="check" size={15} /></span>{decision}</li>)}</ul> : <p className="subtle">No decisions yet. Add them in the Markdown workspace.</p>}</section>;
  const renderActions = () => <section className="actions-section"><div className="section-heading"><h2>Action items</h2><span>{complete} of {actions.length} complete</span></div><div className="action-list">{actions.map((line, i) => {
    const done = /^- \[[xX]\]/.test(line); const text = line.slice(6); const [owner, ...rest] = text.split(' — ');
    return <label className={`action-row ${done ? 'complete' : ''}`} key={i}><input type="checkbox" checked={done} onChange={() => void onMarkdown(toggleAction(markdown, i))} /><span className="action-text">{rest.length ? rest.join(' — ') : text}</span>{rest.length > 0 && <span className="action-owner"><span className="avatar">{owner.slice(0, 1)}</span>{owner}</span>}</label>;
  })}{!actions.length && <p className="subtle">No action items yet. Your manual notes are ready to edit.</p>}</div></section>;
  return <article className="meeting-detail">
    <div className="detail-navigation"><button className="text-button" onClick={onBack}><Icon name="back" size={16} />All meetings</button><button className="icon-button" title={review ? 'Exit review mode' : 'Meeting review mode'} aria-label={review ? 'Exit review mode' : 'Meeting review mode'} onClick={onReview}><Icon name="review" /></button></div>
    <header className="meeting-header"><div className="eyebrow"><span className={`project-dot ${meta.project.toLowerCase()}`} />{meta.project.toUpperCase()}<span className="eyebrow-divider">/</span>MEETING</div><h1>{meta.title}</h1><div className="meeting-meta"><span>{dateLabel(meta.date)}</span><span>{new Date(meta.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span><span><Icon name="clock" size={14} />{durationLabel(meta.duration)}</span><span className={`status-badge ${meta.status}`}>{meta.status}</span></div><div className="participants"><div className="avatar-stack">{meta.participants.slice(0, 4).map((p, i) => <span className={`avatar tone-${i}`} key={p}>{p.split(' ').map(n => n[0]).join('')}</span>)}</div><span>{meta.participants.join(', ')}</span></div></header>
    <nav className="meeting-tabs" aria-label="Meeting sections">{(['Summary', 'Decisions', 'Action items', 'Notes', 'Transcript'] as MeetingTab[]).map(t => <button key={t} aria-current={t === tab ? 'page' : undefined} className={t === tab ? 'selected' : ''} onClick={() => onTab(t)}>{t}{t === 'Action items' && <span>{actions.length}</span>}</button>)}</nav>
    <div className="meeting-content">
      {tab === 'Summary' && <><section className="summary-section"><div className="section-heading"><h2>At a glance</h2><span className="quiet-label">{meta.tags.includes('Prototype') ? 'Prototype record' : 'Demo meeting'}</span></div><p>{section(markdown, 'Summary') || 'No summary yet.'}</p></section>{renderDecisions()}{renderActions()}<div className="meeting-endnote"><Icon name="shield" size={15} />{meta.tags.includes('Prototype') ? 'Prototype capture · no audio recorded' : 'Illustrative meeting · seeded for this prototype'}<span>Markdown, all the way down.</span></div></>}
      {tab === 'Decisions' && renderDecisions()}{tab === 'Action items' && renderActions()}
      {tab === 'Notes' && <section className="notes-section"><div className="section-heading"><div><h2>Manual notes</h2><p className="subtle">Your thoughts, in your own words. Saved as Markdown.</p></div><span className="quiet-label">⌘ B · bold &nbsp; / · format</span></div><div className="quiet-editor"><Suspense fallback={<p className="subtle">Opening your editor…</p>}><Editor onDraftChange={onDraft} key={meta.id} previewMode={{ content: section(markdown, 'Notes'), title: 'Manual notes', filePath: meta.meetingPath, modified: 0, hasExternalChanges: false, reloadVersion: 0, save, reload: async () => {} }} /></Suspense></div></section>}
      {tab === 'Transcript' && <section className="transcript-section"><div className="section-heading"><div><h2>Transcript</h2><p className="subtle">{meta.tags.includes('Prototype') ? 'No transcription was performed.' : 'Demo excerpt · illustrative conversation'}</p></div><label className="transcript-search"><Icon name="search" size={15} /><input placeholder="Find in transcript…" aria-label="Find in transcript" value={transcriptQuery} onChange={e => setTranscriptQuery(e.target.value)} /></label></div>{chunks.map((chunk, i) => {
        const [heading, ...body] = chunk.trim().split('\n'); const [timestamp, ...speaker] = heading.split(' ');
        return <div className="transcript-turn" key={i}><span className="timestamp">{timestamp}</span><div><h3>{speaker.join(' ')}</h3><p>{body.join('\n').trim()}</p></div></div>;
      })}{!chunks.length && <p className="subtle">{transcriptQuery ? 'No matching transcript passages.' : 'There is no transcript for this prototype capture. Add your own notes in Manual notes.'}</p>}</section>}
    </div>
  </article>;
}
