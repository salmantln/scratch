import type { CSSProperties } from 'react';
const paths = {
  meetings: 'M4 3h12l4 4v14H4z M8 8h5 M8 12h8 M8 16h6',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  plus: 'M12 5v14 M5 12h14',
  folder: 'M3 6h6l2 2h10v12H3z',
  arrow: 'M5 12h14 M14 7l5 5-5 5',
  back: 'M19 12H5 M10 7l-5 5 5 5',
  check: 'M5 12l4 4L19 6',
  clock: 'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  shield: 'M12 2l8 4v6c0 5-8 10-8 10S4 17 4 12V6z M8 12l3 3 5-6',
  close: 'M6 6l12 12 M6 18L18 6',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8',
  pause: 'M8 5v14 M16 5v14',
  play: 'M7 4l14 8-14 8z',
  stop: 'M6 6h12v12H6z',
  monitor: 'M2 3h20v14H2z M12 17v4 M7 21h10',
  chevron: 'M8 5l7 7-7 7',
  review: 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5',
  refresh: 'M20 7a9 9 0 1 0 1 9 M20 2v6h-6',
};
export function Icon({ name, size = 18, style }: { name: keyof typeof paths; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}
export function Logo({ size = 28 }: { size?: number }) {
  return <svg className="brand-logo" width={size * 155 / 168} height={size} viewBox="0 0 155 168" fill="none" aria-hidden="true">
    <path d="M134.677 71.4875C137.288 71.7434 139.25 74.102 138.387 76.5794C137.296 79.7098 135.436 82.5447 132.945 84.8065C129.272 88.1421 124.49 89.9931 119.528 90C114.566 90.0069 109.779 88.1691 106.096 84.8437C103.599 82.5889 101.731 79.7592 100.631 76.6318C99.7615 74.1568 101.717 71.7927 104.327 71.5296C106.937 71.2664 109.187 73.2813 110.565 75.5139C111.082 76.3529 111.72 77.1213 112.463 77.7926C114.397 79.5384 116.91 80.5032 119.515 80.4996C122.119 80.4959 124.63 79.5242 126.558 77.7731C127.3 77.0997 127.935 76.3295 128.45 75.4891C129.822 73.2527 132.066 71.2316 134.677 71.4875Z" fill="#151B38" />
    <path d="M80.5 0C113.101 0 141.175 19.3802 153.832 47.248C143.926 35.479 129.087 28 112.5 28C82.6766 28 58.5 52.1766 58.5 82C58.5 95.6945 63.5986 108.198 72 117.717V144H129.98C116.33 154.652 99.1566 161 80.5 161C36.0411 161 0 124.959 0 80.5C0 36.0411 36.0411 0 80.5 0ZM150.388 120.475C147.953 124.723 145.142 128.728 142 132.444V127.236C145.019 125.263 147.828 122.995 150.388 120.475Z" fill="#060C28" />
    <path d="M52 168C52 137.624 76.6243 113 107 113H155C155 143.376 130.376 168 100 168H52Z" fill="#4076FC" />
  </svg>;
}
export function Pulse({ small = false }: { small?: boolean }) { return <span className={`quiet-pulse ${small ? 'small' : ''}`} aria-hidden="true"><i /><i /><i /></span>; }
