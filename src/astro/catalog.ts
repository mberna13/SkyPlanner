// Loads the bundled catalogs (built by scripts/build-catalogs.py) into typed objects.
import * as A from 'astronomy-engine';
import { PLANETS } from './engine';

/** [raHours, decDeg, mag, bv, properName, designation, hip] */
type StarRow = [number, number, number, number, string, string, number];

export interface Star {
  ra: number;
  dec: number;
  mag: number;
  bv: number;
  name: string;
  desig: string;
  hip: number;
}

export interface Constellation {
  id: string;
  name: string;
  rank: number;
  label: [number, number] | null;
  lines: [number, number][][];
}

export type DsoGroup = 'galaxy' | 'cluster' | 'globular' | 'nebula';

export interface Dso {
  id: string;
  cat: string;
  alt: string;
  name: string;
  type: string;
  group: DsoGroup;
  ra: number;
  dec: number;
  mag: number | null;
  size: [number | null, number | null]; // arcminutes
  m: number | null;
}

export type TargetKind = 'star' | 'planet' | 'moon' | 'dso' | 'sat';

/** Anything the app can list, select and plan for. */
export interface Target {
  id: string;
  kind: TargetKind;
  name: string; // full display name
  label: string; // short label for the sky view
  type: string; // "Galaxy", "Planet", ...
  cat: string; // catalogue id, e.g. "M31" or "α Lyr"
  mag: number | null;
  size: [number, number] | null; // arcminutes
  ra?: number; // fixed J2000 position (stars, DSOs)
  dec?: number;
  body?: A.Body; // moving solar-system body
  color?: string;
  dso?: Dso;
  star?: Star;
  norad?: number; // satellites
}

export interface Catalog {
  stars: Star[];
  constellations: Constellation[];
  dsos: Dso[];
  targets: Map<string, Target>;
}

async function getJson<T>(name: string): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/${name}`);
  if (!res.ok) throw new Error(`Could not load ${name}: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function loadCatalog(): Promise<Catalog> {
  const [starRows, constellations, dsos] = await Promise.all([
    getJson<StarRow[]>('stars.json'),
    getJson<Constellation[]>('constellations.json'),
    getJson<Dso[]>('dsos.json'),
  ]);
  const stars: Star[] = starRows.map(([ra, dec, mag, bv, name, desig, hip]) => ({ ra, dec, mag, bv, name, desig, hip }));

  const targets = new Map<string, Target>();
  targets.set('moon', { id: 'moon', kind: 'moon', name: 'Moon', label: 'Moon', type: 'Moon', cat: 'Earth’s moon', mag: -12, size: [31, 31], body: A.Body.Moon, color: '#EDEAE0' });
  for (const p of PLANETS) {
    targets.set(p.name.toLowerCase(), {
      id: p.name.toLowerCase(), kind: 'planet', name: p.name, label: p.name, type: 'Planet',
      cat: 'Solar system', mag: null, size: null, body: p.body, color: p.color,
    });
  }
  for (const d of dsos) {
    const label = d.name && d.name.length <= 18 ? d.name : d.cat;
    const full = d.name ? d.name : d.cat;
    targets.set(d.id, {
      id: d.id, kind: 'dso', name: full, label, type: d.type,
      cat: [d.cat, d.alt].filter(Boolean).join(' · '),
      mag: d.mag,
      size: d.size[0] ? [d.size[0], d.size[1] ?? d.size[0]] : null,
      ra: d.ra, dec: d.dec, dso: d,
    });
  }
  for (const s of stars) {
    if (!s.name) continue;
    const id = `hip${s.hip}`;
    targets.set(id, {
      id, kind: 'star', name: s.name, label: s.name, type: 'Star',
      cat: s.desig || `HIP ${s.hip}`, mag: s.mag, size: null, ra: s.ra, dec: s.dec, star: s,
    });
  }
  return { stars, constellations, dsos, targets };
}

/** Approximate star colour from the B-V colour index. */
export function starColor(bv: number): string {
  if (bv < -0.1) return '#AFC6FF';
  if (bv < 0.15) return '#D2DEFF';
  if (bv < 0.45) return '#F1F3FF';
  if (bv < 0.7) return '#FFF5E3';
  if (bv < 1.1) return '#FFE2B8';
  if (bv < 1.5) return '#FFCB91';
  return '#FFB27A';
}
