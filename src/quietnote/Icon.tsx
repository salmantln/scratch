import type { CSSProperties } from 'react';
const paths = {
  meeting: 'M3 5h18v16H3z M3 10h18 M8 3v4 M16 3v4',
  recent: 'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  settings: 'M4 7h10 M18 7h2 M4 17h4 M12 17h8 M16 5v4 M10 15v4',
  plus: 'M12 5v14 M5 12h14',
  folder: 'M3 6h6l2 2h10v12H3z',
  arrow: 'M5 12h14 M14 7l5 5-5 5',
  back: 'M19 12H5 M10 7l-5 5 5 5',
  check: 'M5 12l4 4L19 6',
  decision: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M8 12l3 3 5-6',
  close: 'M6 6l12 12 M6 18L18 6',
  stop: 'M6 6h12v12H6z',
  archive: 'M3 13h18v7H3z M3 13l3-8h12l3 8 M7 16.5h.01',
  privacy: 'M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.6 M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7c1.9 0 3.6-.6 5-1.5 M9.9 9.9a3 3 0 0 0 4.2 4.2',
  info: 'M12 11v6 M12 7.5h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  open: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  copy: 'M8 8h12v12H8z M16 8V4H4v12h4',
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
