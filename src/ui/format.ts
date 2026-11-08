// Formatting helpers. Times are shown in the device's time zone.
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

export function fmtTime(ms: number | Date): string {
  return timeFmt.format(ms instanceof Date ? ms : new Date(ms));
}

export function fmtDay(ms: number | Date): string {
  return dayFmt.format(ms instanceof Date ? ms : new Date(ms));
}

/** "2h 55m", "40m", "1h" */
export function fmtDur(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60e3));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function fmtMag(m: number | null | undefined): string {
  if (m === null || m === undefined || m > 50) return '—';
  return (m < 0 ? '−' : '') + Math.abs(m).toFixed(1);
}

export function fmtDeg(d: number): string {
  return `${Math.round(d)}°`;
}

export function fmtLatLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape text for use inside HTML templates. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}
