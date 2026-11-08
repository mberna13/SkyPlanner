// Core sky math: J2000 RA/Dec -> local altitude/azimuth, Sun/Moon/planets,
// the darkness window for a night, and altitude curves over that night.
import * as A from 'astronomy-engine';

export const DEG = Math.PI / 180;

export interface Site {
  lat: number;
  lon: number;
  elev: number; // metres
  name?: string;
}

export interface HorPos {
  alt: number; // degrees, refracted
  az: number; // degrees east of north
}

export function observerFor(site: Site): A.Observer {
  return new A.Observer(site.lat, site.lon, site.elev);
}

/** One instant for one observer. Precomputes the J2000 -> horizon rotation. */
export class Frame {
  readonly time: A.AstroTime;
  private readonly m: number[][];

  constructor(readonly date: Date, readonly observer: A.Observer) {
    this.time = A.MakeTime(date);
    this.m = A.Rotation_EQJ_HOR(this.time, observer).rot;
  }

  /** RA in hours, Dec in degrees, both J2000. */
  radec(raHours: number, decDeg: number, refract = true): HorPos {
    const ra = raHours * 15 * DEG;
    const dec = decDeg * DEG;
    const cd = Math.cos(dec);
    const x = cd * Math.cos(ra);
    const y = cd * Math.sin(ra);
    const z = Math.sin(dec);
    const m = this.m;
    const hx = m[0][0] * x + m[1][0] * y + m[2][0] * z;
    const hy = m[0][1] * x + m[1][1] * y + m[2][1] * z;
    const hz = m[0][2] * x + m[1][2] * y + m[2][2] * z;
    let alt = Math.asin(Math.max(-1, Math.min(1, hz))) / DEG;
    let az = Math.atan2(-hy, hx) / DEG;
    if (az < 0) az += 360;
    if (refract && alt > -2) alt += A.Refraction('normal', alt);
    return { alt, az };
  }

  /** Topocentric J2000 RA/Dec of a solar-system body. */
  bodyRaDec(body: A.Body): { ra: number; dec: number; dist: number } {
    const eq = A.Equator(body, this.time, this.observer, false, true);
    return { ra: eq.ra, dec: eq.dec, dist: eq.dist };
  }

  body(body: A.Body): HorPos {
    const eq = this.bodyRaDec(body);
    return this.radec(eq.ra, eq.dec);
  }

  sunAlt(): number {
    return this.body(A.Body.Sun).alt;
  }
}

export const PLANETS: { body: A.Body; name: string; color: string }[] = [
  { body: A.Body.Mercury, name: 'Mercury', color: '#C9B8A6' },
  { body: A.Body.Venus, name: 'Venus', color: '#FFF1C9' },
  { body: A.Body.Mars, name: 'Mars', color: '#FF9C6B' },
  { body: A.Body.Jupiter, name: 'Jupiter', color: '#FFD9A0' },
  { body: A.Body.Saturn, name: 'Saturn', color: '#FFCF8A' },
  { body: A.Body.Uranus, name: 'Uranus', color: '#A8E6E0' },
  { body: A.Body.Neptune, name: 'Neptune', color: '#8FB4FF' },
];

export function bodyMag(body: A.Body, date: Date): number {
  try {
    return A.Illumination(body, A.MakeTime(date)).mag;
  } catch {
    return 99;
  }
}

export function moonInfo(date: Date): { fraction: number; phaseAngle: number; waxing: boolean } {
  const t = A.MakeTime(date);
  const ill = A.Illumination(A.Body.Moon, t);
  const elong = A.MoonPhase(t); // 0 new, 90 first quarter, 180 full
  return { fraction: ill.phase_fraction, phaseAngle: elong, waxing: elong < 180 };
}

/** Angular separation in degrees between two RA(h)/Dec(deg) points. */
export function separation(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a1 = ra1 * 15 * DEG;
  const a2 = ra2 * 15 * DEG;
  const d1 = dec1 * DEG;
  const d2 = dec2 * DEG;
  const c = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(a1 - a2);
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

// ---------------------------------------------------------------- the night

export interface Night {
  sunset: Date;
  sunrise: Date;
  civilDusk: Date | null; // sun at -6
  nauticalDusk: Date | null; // -12
  dusk: Date | null; // -18, astronomical
  dawn: Date | null;
  nauticalDawn: Date | null;
  civilDawn: Date | null;
  /** Dark window: astronomical dusk -> dawn, or the deepest available if it never gets fully dark. */
  darkStart: Date;
  darkEnd: Date;
  fullyDark: boolean;
  moonrise: Date | null;
  moonset: Date | null;
  moonFraction: number; // at the middle of the night
}

function search(
  fn: () => A.AstroTime | null,
): Date | null {
  try {
    const t = fn();
    return t ? t.date : null;
  } catch {
    return null;
  }
}

/**
 * The night that is in progress at `now`, or the coming one if it is daytime.
 * Returns null where the Sun doesn't set (polar summer).
 */
export function nightFor(now: Date, site: Site): Night | null {
  const obs = observerFor(site);
  const sunUp = new Frame(now, obs).sunAlt() > -0.833;
  const from = sunUp ? now : new Date(now.getTime() - 20 * 3600e3);
  const sunset = search(() => A.SearchRiseSet(A.Body.Sun, obs, -1, A.MakeTime(from), 1.5));
  if (!sunset) return null;
  const t0 = A.MakeTime(sunset);
  const sunrise = search(() => A.SearchRiseSet(A.Body.Sun, obs, +1, t0, 1.5));
  if (!sunrise) return null;
  const span = (sunrise.getTime() - sunset.getTime()) / 86400e3;
  const alt = (dir: 1 | -1, a: number) => {
    const d = search(() => A.SearchAltitude(A.Body.Sun, obs, dir, t0, span, a));
    return d && d < sunrise ? d : null;
  };
  const civilDusk = alt(-1, -6);
  const nauticalDusk = alt(-1, -12);
  const dusk = alt(-1, -18);
  const dawn = alt(+1, -18);
  const nauticalDawn = alt(+1, -12);
  const civilDawn = alt(+1, -6);
  const fullyDark = !!(dusk && dawn);
  const darkStart = dusk ?? nauticalDusk ?? civilDusk ?? sunset;
  const darkEnd = dawn ?? nauticalDawn ?? civilDawn ?? sunrise;

  const searchStart = A.MakeTime(new Date(sunset.getTime() - 3600e3));
  const searchDays = span + 2 / 24;
  const mr = search(() => A.SearchRiseSet(A.Body.Moon, obs, +1, searchStart, searchDays));
  const ms = search(() => A.SearchRiseSet(A.Body.Moon, obs, -1, searchStart, searchDays));
  const mid = new Date((sunset.getTime() + sunrise.getTime()) / 2);
  return {
    sunset, sunrise, civilDusk, nauticalDusk, dusk, dawn, nauticalDawn, civilDawn,
    darkStart, darkEnd, fullyDark,
    moonrise: mr, moonset: ms,
    moonFraction: moonInfo(mid).fraction,
  };
}

// ------------------------------------------------------------ time sampling

export interface Timeline {
  start: number; // ms
  stepMs: number;
  frames: Frame[];
  sunAlt: Float32Array;
  moonAlt: Float32Array;
  moonRa: Float32Array;
  moonDec: Float32Array;
}

export function buildTimeline(start: Date, end: Date, site: Site, stepMin = 5): Timeline {
  const obs = observerFor(site);
  const stepMs = stepMin * 60e3;
  const n = Math.max(2, Math.ceil((end.getTime() - start.getTime()) / stepMs) + 1);
  const frames: Frame[] = [];
  const sunAlt = new Float32Array(n);
  const moonAlt = new Float32Array(n);
  const moonRa = new Float32Array(n);
  const moonDec = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const f = new Frame(new Date(start.getTime() + i * stepMs), obs);
    frames.push(f);
    sunAlt[i] = f.sunAlt();
    const m = f.bodyRaDec(A.Body.Moon);
    moonRa[i] = m.ra;
    moonDec[i] = m.dec;
    moonAlt[i] = f.radec(m.ra, m.dec).alt;
  }
  return { start: start.getTime(), stepMs, frames, sunAlt, moonAlt, moonRa, moonDec };
}

export function timeAt(tl: Timeline, i: number): number {
  return tl.start + i * tl.stepMs;
}

export function indexAt(tl: Timeline, ms: number): number {
  return (ms - tl.start) / tl.stepMs;
}

/** Linear-interpolated value of a sampled series at a time. */
export function sampleAt(series: ArrayLike<number>, tl: Timeline, ms: number): number {
  const x = indexAt(tl, ms);
  const i = Math.floor(x);
  if (i < 0) return series[0];
  if (i >= series.length - 1) return series[series.length - 1];
  const f = x - i;
  return series[i] * (1 - f) + series[i + 1] * f;
}

/** Times where the series crosses `level` going up (+1) or down (-1). */
export function crossings(series: ArrayLike<number>, tl: Timeline, level: number, dir: 1 | -1): number[] {
  const out: number[] = [];
  for (let i = 0; i < series.length - 1; i++) {
    const a = series[i] - level;
    const b = series[i + 1] - level;
    if (dir > 0 ? a < 0 && b >= 0 : a >= 0 && b < 0) {
      const f = a / (a - b);
      out.push(tl.start + (i + f) * tl.stepMs);
    }
  }
  return out;
}

/** Peak of a series between two times (ms), refined with a parabola. */
export function peak(series: ArrayLike<number>, tl: Timeline, fromMs = tl.start, toMs = Infinity): { ms: number; value: number } {
  const i0 = Math.max(0, Math.ceil(indexAt(tl, fromMs)));
  const i1 = Math.min(series.length - 1, Math.floor(indexAt(tl, toMs)));
  let best = i0;
  for (let i = i0; i <= i1; i++) if (series[i] > series[best]) best = i;
  let ms = timeAt(tl, best);
  let value = series[best];
  if (best > i0 && best < i1) {
    const y0 = series[best - 1], y1 = series[best], y2 = series[best + 1];
    const d = y0 - 2 * y1 + y2;
    if (d < 0) {
      const off = (0.5 * (y0 - y2)) / d;
      ms += off * tl.stepMs;
      value = y1 - 0.25 * (y0 - y2) * off;
    }
  }
  return { ms, value };
}

// ---------------------------------------------------------------- helpers

/** Galactic plane (b = 0) as J2000 RA(h)/Dec(deg) points, for drawing the Milky Way band. */
export function galacticPlane(stepDeg = 3): [number, number][] {
  // Rows of the galactic -> J2000 equatorial rotation matrix.
  const R = [
    [-0.0548755604, 0.4941094279, -0.867666149],
    [-0.8734370902, -0.4448296300, -0.1980763734],
    [-0.4838350155, 0.7469822445, 0.4559837762],
  ];
  const pts: [number, number][] = [];
  for (let l = 0; l <= 360; l += stepDeg) {
    const gx = Math.cos(l * DEG), gy = Math.sin(l * DEG), gz = 0;
    // equatorial = R * galactic (galactic centre comes out at 17.76h, -28.9 deg)
    const x = R[0][0] * gx + R[0][1] * gy + R[0][2] * gz;
    const y = R[1][0] * gx + R[1][1] * gy + R[1][2] * gz;
    const z = R[2][0] * gx + R[2][1] * gy + R[2][2] * gz;
    let ra = Math.atan2(y, x) / DEG / 15;
    if (ra < 0) ra += 24;
    pts.push([ra, Math.asin(z) / DEG]);
  }
  return pts;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(az: number): string {
  return COMPASS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
}
