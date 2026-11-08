// Predicts visible satellite passes over a night window. Runs in a Web Worker.
import { buildSats, lookAt, siteGeodetic, type Pass, type PassPoint, type PassRequest } from './satellites';

const STEP_MS = 20e3;
const MIN_ALT = 10;
const DARK_SUN_ALT = -6;
const MAG_LIMIT = 4.5;

self.onmessage = (ev: MessageEvent<PassRequest>) => {
  const req = ev.data;
  const sats = buildSats(req.omm);
  const gd = siteGeodetic(req.site);
  const sunAltAt = (ms: number) => {
    const x = (ms - req.start) / req.sunStepMs;
    const i = Math.max(0, Math.min(req.sunAlt.length - 2, Math.floor(x)));
    const f = Math.max(0, Math.min(1, x - i));
    return req.sunAlt[i] * (1 - f) + req.sunAlt[i + 1] * f;
  };
  const passes: Pass[] = [];

  for (const sat of sats) {
    // Skip element sets that are badly out of date: positions would be wrong.
    if (Math.abs(req.start - sat.epoch.getTime()) > 14 * 86400e3) continue;
    let cur: { rise: PassPoint; max: PassPoint; last: PassPoint; visStart: PassPoint | null; visEnd: PassPoint | null; mag: number } | null = null;
    let ms = req.start;
    while (ms <= req.end) {
      const lk = lookAt(sat, new Date(ms), gd);
      if (!lk) break;
      // Far below the horizon: jump ahead faster.
      if (!cur && lk.alt < -25) {
        ms += STEP_MS * 6;
        continue;
      }
      const p: PassPoint = { ms, alt: lk.alt, az: lk.az };
      if (lk.alt >= MIN_ALT) {
        if (!cur) cur = { rise: p, max: p, last: p, visStart: null, visEnd: null, mag: 99 };
        if (p.alt > cur.max.alt) cur.max = p;
        cur.last = p;
        const visible = lk.sunlit && sunAltAt(ms) < DARK_SUN_ALT;
        if (visible) {
          if (!cur.visStart) cur.visStart = p;
          cur.visEnd = p;
          cur.mag = Math.min(cur.mag, lk.mag);
        }
      } else if (cur) {
        if (cur.visStart && cur.mag <= MAG_LIMIT) {
          passes.push({
            norad: sat.norad, name: sat.name,
            rise: cur.rise, max: cur.max, set: cur.last,
            visStart: cur.visStart, visEnd: cur.visEnd, mag: cur.mag,
          });
        }
        cur = null;
      }
      ms += STEP_MS;
    }
  }
  passes.sort((a, b) => a.visStart!.ms - b.visStart!.ms);
  (self as unknown as Worker).postMessage(passes);
};
