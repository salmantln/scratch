import { createContext, useContext, useRef, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
/** Hush shows what QuietNote is doing; each mood is a real state of the app, never decoration. Motion only adds to
 * each mood's pose from the Paper file, and with Reduce motion the pose holds (quietnote.css, "Hush"). */
export type Mood = 'resting' | 'ready' | 'listening' | 'paused' | 'transcribing' | 'suggesting' | 'done' | 'attention' | 'winding';
/** While listening, the eyes turn to the side that's talking: you (the mic) or the others (the call audio). */
export type Look = 'you' | 'others' | null;
const BODY = 'M38 72 C42 46 62 31 98 28 L140 30 L144 43 C159 45 168 54 171 70 C178 91 179 115 172 140 C169 148 165 154 160 158 L168 183 L137 184 L129 172 L104 172 L102 184 L66 182 L64 164 C41 152 30 132 30 104 C30 92 32 81 38 72 Z';
const LEAF = 'M52 168C52 137.624 76.624 113 107 113H155C155 143.376 130.376 168 100 168H52Z';
const LEAF_AT = 'translate(61 35) rotate(-18) scale(0.66) translate(-103.5 -140.5)';
const EYES: Record<string, ReactNode> = {
  dots: <><circle cx="100" cy="92" r="9" /><circle cx="132" cy="92" r="9" /></>,
  wide: <><circle cx="99" cy="92" r="10.5" /><circle cx="131" cy="92" r="10.5" /></>,
  closed: <><path className="h-st" d="M89 90 Q100 102 111 90" /><path className="h-st" d="M121 90 Q132 102 143 90" /></>,
  happy: <><path className="h-st" d="M89 97 Q100 84 111 97" /><path className="h-st" d="M121 97 Q132 84 143 97" /></>,
  line: <><path className="h-st" d="M90 93 H110" /><path className="h-st" d="M122 93 H142" /></>,
  droop: <><path d="M91 92 A9 9 0 0 0 109 92 Z" /><path d="M123 92 A9 9 0 0 0 141 92 Z" /></>,
  worried: <><circle cx="100" cy="94" r="10" /><circle cx="132" cy="94" r="10" /><polygon className="h-brow" points="84,62 114,62 114,86 84,96" /><polygon className="h-brow" points="118,62 150,62 150,96 118,86" /></>,
};
// The faces each mood can show; the last is its resting pose.
const FACES: Record<Mood, string[]> = { resting: ['closed'], ready: ['dots'], listening: ['wide'], paused: ['line'], transcribing: ['dots'], suggesting: ['dots'], done: ['dots', 'happy'], attention: ['dots', 'worried'], winding: ['droop'] };
const EXTRAS: Partial<Record<Mood, ReactNode>> = {
  resting: <>{['M160 14 h9 l-9 10 h9', 'M174 -2 h11 l-11 12 h11', 'M190 -20 h13 l-13 14 h13'].map((d, i) => <g key={d} className={`h-z h-z${i + 1}`}><path d={d} /></g>)}</>,
  listening: <g className="h-rec"><circle className="h-rec-ring" cx="178" cy="36" r="16" /><circle className="h-rec-dot" cx="178" cy="36" r="10" /></g>,
  suggesting: <g className="h-bubble"><rect className="h-bubble-cut" x="150" y="-14" width="62" height="38" rx="15" /><rect className="h-bubble-fill" x="150" y="-14" width="62" height="38" rx="15" />
    <polygon className="h-bubble-fill" points="160,20 176,20 156,36" />{[165, 181, 197].map(cx => <circle key={cx} className="h-dot" cx={cx} cy="5" r="4.2" />)}</g>,
};
// While transcribing, Hush comes apart into these pieces behind him and they float until the transcript is saved.
const PIECES = <><g className="h-apart-l"><g className="h-left"><polygon className="h-ink" points="-6,112 42,106 46,156 -2,160" /></g></g>
  <g className="h-mid"><polygon className="h-ink" points="62,74 134,70 138,150 66,154" /><g className="h-mid-eyes"><circle cx="94" cy="106" r="8" /><circle cx="118" cy="106" r="8" /></g></g></>;

// Settings → Appearance → Show Hush, shared by every Hush in this window.
let shown = true;
const watchers = new Set<() => void>();
export function showHush(on: boolean) { if (on !== shown) { shown = on; watchers.forEach(f => f()); } }
export const useHushShown = () => useSyncExternalStore(f => { watchers.add(f); return () => { watchers.delete(f); }; }, () => shown);

/** One Hush per screen: inside a `HushYield` that's true, another Hush already has the screen. */
export const HushYield = createContext(false);
/** Turned off or yielding, `fallback` (the status dot, logo or icon he replaced) is shown instead. While
 * transcribing, `progress` (0–1) brings the pieces back together as the real percentage climbs. */
export function Hush({ mood, size = 40, look = null, fallback = null, progress }: { mood: Mood; size?: number; look?: Look; fallback?: ReactNode; progress?: number }) {
  const shown = useHushShown(), yielded = useContext(HushYield);
  if (!shown || yielded) return fallback;
  return <svg className={`hush hush-${mood}${look ? ` look-${look}` : ''}`} style={progress === undefined ? undefined : { '--hush-progress': progress } as CSSProperties} width={size} height={size} viewBox="-20 -24 240 240" aria-hidden="true" focusable="false">
    {mood === 'transcribing' && PIECES}
    <g className="h-rig"><g className="h-breath"><g className="h-sway">
      <g className="h-morph"><path className="h-ink h-body" d={BODY} />
        <g className="h-face"><g className="h-glance"><g className="h-blink">{FACES[mood].map(f => <g key={f} className={`h-eyes h-e-${f}`}>{EYES[f]}</g>)}</g></g></g></g>
      <g className="h-apart-r"><g className="h-leaf"><g className="h-leaf-y"><g className="h-leaf-tilt"><path className="h-leaf-cut" transform={LEAF_AT} d={LEAF} /><path className="h-leaf-fill" transform={LEAF_AT} d={LEAF} />
        {mood === 'done' && <path className="h-check" pathLength={1} d="M50 37 L58 44 L72 29" />}</g></g></g></g>
      {EXTRAS[mood]}
    </g></g></g>
  </svg>;
}
/** The side that's talking, from the recorder's live levels (mic, call audio). A side stays looked at for a moment
 * after it goes quiet, so the eyes don't flick back between words. */
export function useLook([mic, system]: [number, number]): Look {
  const last = useRef<{ side: Look; at: number }>({ side: null, at: 0 });
  if (Math.max(mic, system) > 0.02) last.current = { side: mic >= system ? 'you' : 'others', at: Date.now() };
  return Date.now() - last.current.at < 1200 ? last.current.side : null;
}
