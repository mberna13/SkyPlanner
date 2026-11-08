// Satellites: CelesTrak OMM data -> SGP4 -> look angles, sunlit test and brightness estimate.
import {
  json2satrec, propagate, gstime, eciToEcf, ecfToLookAngles, geodeticToEcf, ecfToEci,
  sunPos, jday, shadowFraction, degreesToRadians,
  type SatRec, type OMMJsonObject, type GeodeticLocation,
} from './sat-lib';
import type { Site } from './engine';

export const DEFAULT_SAT_URLS = [
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=json',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json',
];

/** Standard magnitude (1000 km range, half lit) for a few well-known objects. */
const STD_MAG: Record<number, number> = {
  25544: -1.8, // ISS
  48274: -0.9, // Tiangong (Tianhe core)
  20580: 2.2, // Hubble
  43013: 3.5,
};
const DEFAULT_STD_MAG = 3.5;
const CACHE_KEY = 'sp.satdata.v1';
const MAX_AGE_MS = 8 * 3600e3;
const MIN_REFETCH_MS = 2 * 3600e3; // CelesTrak asks clients not to hammer the same group

export interface Sat {
  norad: number;
  name: string;
  stdMag: number;
  rec: SatRec;
  epoch: Date;
}

export interface SatData {
  omm: OMMJsonObject[];
  fetchedAt: number;
  source: 'network' | 'cache';
}

function readCache(): SatData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as SatData;
    return { ...d, source: 'cache' };
  } catch {
    return null;
  }
}

function writeCache(d: SatData) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ omm: d.omm, fetchedAt: d.fetchedAt }));
  } catch {
    /* storage full or blocked: keep the in-memory copy */
  }
}

/** Returns cached data when fresh enough, else fetches. Falls back to stale cache on network failure. */
export async function loadSatData(urls: string[], force = false): Promise<SatData | null> {
  const cached = readCache();
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;
  const fresh = force ? age < MIN_REFETCH_MS : age < MAX_AGE_MS;
  if (cached && fresh) return cached;
  try {
    const lists = await Promise.all(
      urls.map(async (u) => {
        const r = await fetch(u, { cache: 'no-store' });
        if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
        return (await r.json()) as OMMJsonObject[];
      }),
    );
    const byId = new Map<number, OMMJsonObject>();
    for (const list of lists) for (const o of list) byId.set(Number(o.NORAD_CAT_ID), o);
    const d: SatData = { omm: [...byId.values()], fetchedAt: Date.now(), source: 'network' };
    writeCache(d);
    return d;
  } catch (e) {
    console.warn('[sky-planner] satellite fetch failed', e);
    return cached;
  }
}

export function buildSats(omm: OMMJsonObject[]): Sat[] {
  const out: Sat[] = [];
  for (const o of omm) {
    try {
      const rec = json2satrec(o);
      const norad = Number(o.NORAD_CAT_ID);
      out.push({
        norad,
        name: prettyName(o.OBJECT_NAME),
        stdMag: STD_MAG[norad] ?? DEFAULT_STD_MAG,
        rec,
        epoch: new Date(String(o.EPOCH) + (String(o.EPOCH).endsWith('Z') ? '' : 'Z')),
      });
    } catch {
      /* skip malformed element sets */
    }
  }
  return out;
}

export function prettyName(raw: string): string {
  if (/^ISS \(ZARYA\)/.test(raw)) return 'ISS';
  if (/^CSS \(TIANHE\)/.test(raw)) return 'Tiangong';
  if (/^HST$/.test(raw)) return 'Hubble';
  return raw
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bR\/B\b/i, 'rocket body')
    .replace(/\b(Iss|Css|Hst|Noaa|Sl|Atlas|Cz|Usa)\b/g, (m) => m.toUpperCase());
}

export interface SatLook {
  alt: number; // deg
  az: number; // deg
  range: number; // km
  sunlit: boolean;
  mag: number; // estimated; 99 when in shadow
}

export function siteGeodetic(site: Site): GeodeticLocation {
  return {
    latitude: degreesToRadians(site.lat),
    longitude: degreesToRadians(site.lon),
    height: site.elev / 1000,
  };
}

/** Position of one satellite for an observer. Returns null when SGP4 fails (decayed or bad data). */
export function lookAt(sat: Sat, date: Date, gd: GeodeticLocation): SatLook | null {
  const pv = propagate(sat.rec, date);
  if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
  const gmst = gstime(date);
  const pos = pv.position;
  const look = ecfToLookAngles(gd, eciToEcf(pos, gmst));
  const alt = (look.elevation * 180) / Math.PI;
  const az = (look.azimuth * 180) / Math.PI;
  const sun = sunPos(jday(date)).rsun;
  const shade = shadowFraction(sun, pos);
  const sunlit = shade < 0.5;
  let mag = 99;
  if (sunlit) {
    const obs = ecfToEci(geodeticToEcf(gd), gmst);
    const KM_AU = 149597870.7;
    const toSun = [sun.x * KM_AU - pos.x, sun.y * KM_AU - pos.y, sun.z * KM_AU - pos.z];
    const toObs = [obs.x - pos.x, obs.y - pos.y, obs.z - pos.z];
    const dot = toSun[0] * toObs[0] + toSun[1] * toObs[1] + toSun[2] * toObs[2];
    const beta = Math.acos(Math.max(-1, Math.min(1, dot / (Math.hypot(...toSun) * Math.hypot(...toObs)))));
    // Diffuse sphere phase function, normalised to 1 at 90 degrees.
    const f = (Math.sin(beta) + (Math.PI - beta) * Math.cos(beta));
    mag = sat.stdMag + 5 * Math.log10(look.rangeSat / 1000) - 2.5 * Math.log10(Math.max(f, 1e-3));
  }
  return { alt, az, range: look.rangeSat, sunlit, mag };
}

// ------------------------------------------------------------------ passes

export interface PassPoint {
  ms: number;
  alt: number;
  az: number;
}

export interface Pass {
  norad: number;
  name: string;
  rise: PassPoint; // above 10 deg
  max: PassPoint;
  set: PassPoint;
  visStart: PassPoint | null; // sunlit, above 10 deg, observer's sky dark enough
  visEnd: PassPoint | null;
  mag: number; // brightest estimate while visible
}

export interface PassRequest {
  omm: OMMJsonObject[];
  site: Site;
  start: number;
  end: number;
  /** Sun altitude at the observer, sampled every `stepMs` from `start`. */
  sunAlt: number[];
  sunStepMs: number;
}
