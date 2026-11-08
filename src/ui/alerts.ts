// Alerts: in-browser notifications while the app is open, plus calendar (.ics) events,
// which your phone's calendar will remind you about even when the app is closed.
import type { Alert } from '../state';

type Toast = (msg: string) => void;
const timers = new Map<string, number>();

export async function ensurePermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

export function notificationState(): 'granted' | 'denied' | 'default' | 'unsupported' {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

/** (Re)arm timers for every future alert. Timers longer than ~24 days overflow, so cap them. */
export function scheduleAlerts(alerts: Alert[], toast: Toast, onFired: (a: Alert) => void) {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  const now = Date.now();
  for (const a of alerts) {
    const wait = a.at - now;
    if (wait < -60e3 || wait > 20 * 86400e3) continue;
    timers.set(a.id, window.setTimeout(() => fire(a, toast, onFired), Math.max(0, wait)));
  }
}

async function fire(a: Alert, toast: Toast, onFired: (a: Alert) => void) {
  const body = `${a.name} ${a.what}.`;
  toast(`⏰ ${body}`);
  try {
    navigator.vibrate?.([200, 100, 200]);
  } catch {
    /* not supported */
  }
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.showNotification('Sky Planner', { body, tag: a.id, icon: 'icon-192.png' });
      else new Notification('Sky Planner', { body, tag: a.id });
    } catch {
      new Notification('Sky Planner', { body, tag: a.id });
    }
  }
  onFired(a);
}

function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsEscape(s: string): string {
  return s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
}

/** Download a calendar event at `eventMs` with a reminder `leadMin` minutes before. */
export function downloadIcs(title: string, description: string, eventMs: number, leadMin: number, durationMin = 30) {
  const uid = `${eventMs}-${Math.random().toString(36).slice(2)}@sky-planner`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sky Planner//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(eventMs)}`,
    `DTEND:${icsDate(eventMs + durationMin * 60e3)}`,
    `SUMMARY:${icsEscape(title)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(title)}`,
    `TRIGGER:-PT${Math.max(0, Math.round(leadMin))}M`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'sky-event'}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
