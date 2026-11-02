import { useEffect, useState, type FormEvent } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Icon } from './Icon';
import { askMeeting, desktop, device, type Answer } from './storage';
import { useProgress, type Summarizer } from './Suggestions';
import { clock } from './model';

type Asked = { question: string; answer?: Answer; error?: string; done?: 'copied' | 'added' | 'unsaved' | 'failed' };
/** An answer as lines, each with the time of the transcript line it cites. */
const answerLines = (answer: Answer) => answer.lines.map(l => `- ${l.text} [${clock(l.atMs / 1000)}]`).join('\n');
/** "Ask about this meeting", pinned at the bottom of a recorded meeting as in Granola. Pressing Ask sends the
 * question to the model the user chose, with the transcript (the line under the field says where it goes);
 * every sentence of an answer cites the transcript. Answers stay until the meeting closes: nothing is saved
 * unless Add to my notes. */
export function AskBar({ meetingId, summarizer, onCite, onAppend, onWorking }: {
  meetingId: string; summarizer: Summarizer; onCite: (atMs: number) => void; onAppend: (text: string) => Promise<'saved' | 'unsaved'>; onWorking: (working: boolean) => void;
}) {
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState<Asked[]>([]);
  const [working, setWorking] = useState(false);
  // Reported as done if the bar goes while a question is out (Record more), so Hush can rest again.
  useEffect(() => { onWorking(working); return () => onWorking(false); }, [working, onWorking]);
  const part = useProgress(meetingId, 'ask', working);
  const mark = (i: number, done: Asked['done']) => setAsked(all => all.map((a, k) => k === i ? { ...a, done } : a));
  async function ask(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || working) return;
    setWorking(true); setQuestion('');
    try { const answer = await askMeeting(meetingId, q); setAsked(all => [...all, { question: q, answer }]); }
    catch (err) { setAsked(all => [...all, { question: q, error: String(err).replace(/^Error: /, '') }]); }
    setWorking(false);
  }
  async function copy(i: number, a: Asked) {
    const text = `${a.question}\n${answerLines(a.answer!)}`;
    try { if (desktop) await writeText(text); else await navigator.clipboard.writeText(text); mark(i, 'copied'); }
    catch { /* The button stays as it was. */ }
  }
  const add = (i: number, a: Asked) => void onAppend(`**${a.question}**\n${answerLines(a.answer!)}`).then(saved => mark(i, saved === 'saved' ? 'added' : 'unsaved'), () => mark(i, 'failed'));
  const caption = summarizer.local ? `Answered by ${summarizer.label} on this ${device}. Nothing leaves it.` : 'Your question and this meeting’s transcript text go to Claude with your key.';
  const read = (p: NonNullable<Answer['partial']>) => p.words.length
    ? `Read only the ${p.read} of ${p.total} lines that mention ${p.words.map(w => `“${w}”`).join(', ')}.`
    : `Read ${p.read} of ${p.total} lines, from across the meeting.`;
  return <section className="ask-dock" aria-label="Ask about this meeting">
    {(asked.length > 0 || working) && <div className="ask-answers" role="log" aria-live="polite">
      {asked.map((a, i) => <div className="ask-answer" key={i}>
        <p className="ask-question">{a.question}</p>
        {a.error ? <p className="field-error" role="alert">{a.error}</p>
          : a.answer!.unanswered ? <p className="subtle">The transcript doesn’t say.</p>
          : <ul>{a.answer!.lines.map((l, k) => <li key={k}>{l.text} <button className="citation" title="Show this line in the transcript" onClick={() => onCite(l.atMs)}><span className="timestamp">{clock(l.atMs / 1000)}</span>“{l.quote}”</button></li>)}</ul>}
        {a.answer?.partial && <p className="subtle">{read(a.answer.partial)}</p>}
        {a.answer && a.answer.dropped > 0 && <p className="subtle">{a.answer.dropped === 1 ? 'One more sentence was' : `${a.answer.dropped} more sentences were`} left out because {a.answer.dropped === 1 ? 'it' : 'they'} couldn’t be traced to the transcript.</p>}
        {a.answer && !a.answer.unanswered && <div className="suggestion-actions">
          <button className="text-button" onClick={() => void copy(i, a)}>{a.done === 'copied' ? 'Copied' : 'Copy'}</button>
          <button className="text-button" disabled={a.done === 'added' || a.done === 'unsaved'} onClick={() => add(i, a)}>{a.done === 'added' ? 'Added to my notes' : a.done === 'unsaved' ? 'Added, not saved yet' : a.done === 'failed' ? 'Couldn’t add. Try again' : 'Add to my notes'}</button></div>}
      </div>)}
      {working && <p className="subtle" role="status">Reading the transcript with {summarizer.label}…{part && ` ${part}`}</p>}
    </div>}
    <form className="ask-field" onSubmit={e => void ask(e)}>
      <input aria-label="Ask about this meeting" placeholder="Ask about this meeting" value={question} maxLength={500} onChange={e => setQuestion(e.target.value)} />
      <button type="submit" className="icon-button" aria-label="Ask" disabled={!question.trim() || working}><Icon name="arrow" size={16} /></button>
    </form>
    <p className="ask-caption">{caption}</p>
  </section>;
}
