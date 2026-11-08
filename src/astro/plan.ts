// Tonight's plan: altitude curves, scores and plain-language status for every candidate target.
import type { Catalog, Target } from './catalog';
import {
  buildTimeline, crossings, peak, sampleAt, separation, bodyMag, moonInfo,
  type Night, type Site, type Timeline,
} from './engine';
import type { Pass } from './satellites';
import { fmtTime, fmtDur } from '../ui/format';

export type EquipmentId = 'eye' | 'bino' | 'seestar';

export interface Equipment {
  id: EquipmentId;
  label: string;
  /** Field of view in arcminutes [width, height], or null for the naked eye. */
  fov: [number, number] | null;
  /** Faintest deep-sky magnitude worth suggesting, given the naked-eye sky limit. */
  dsoLimit: (skyLimit: number) => number;
}

export const EQUIPMENT: Record<EquipmentId, Equipment> = {
  eye: { id: 'eye', label: 'Naked eye', fov: null, dsoLimit: (L) => L - 1.2 },
  bino: { id: 'bino', label: 'Binoculars', fov: [390, 390], dsoLimit: (L) => L + 2.5 },
  // Seestar S50: 250 mm focal length, IMX462 sensor -> about 1.29 x 0.73 degrees.
  seestar: { id: 'seestar', label: 'Seestar S50', fov: [77.4, 43.8], dsoLimit: (L) => L + 6 },
};

export const SKY_LIMITS = [
  { value: 6.5, label: 'Dark site (Bortle 1–3)' },
  { value: 6.0, label: 'Rural (Bortle 4)' },
  { value: 5.0, label: 'Suburban (Bortle 5–6)' },
  { value: 4.0, label: 'City (Bortle 7–9)' },
];

export interface PlanItem {
  target: Target;
  curve: Float32Array; // altitude every timeline step
  peak: { ms: number; value: number }; // best altitude while dark
  rise: number | null; // first upward horizon crossing in the window
  set: number | null;
  clears: number | null; // first upward crossing of the minimum altitude
  drops: number | null; // first downward crossing of the minimum altitude after `clears` or now
  minutesUsable: number; // dark minutes above the minimum altitude
  bestStart: number | null; // first/last usable dark moment
  bestEnd: number | null;
  moonSep: number; // degrees, at peak
  moonUpAtPeak: boolean;
  score: number;
  fit: string; // equipment fit note
  pass?: Pass;
}

export interface Plan {
  night: Night;
  timeline: Timeline;
  items: PlanItem[];
  passes: PlanItem[];
  equipment: EquipmentId;
  minAlt: number;
  skyLimit: number;
}

// How rewarding each planet is to look at, for ranking.
const PLANET_POP: Record<string, number> = { Jupiter: 1, Saturn: 1, Mars: 0.9, Venus: 0.85, Mercury: 0.6, Uranus: 0.4, Neptune: 0.3 };

function clamp(x: number, a = 0, b = 1) {
  return Math.max(a, Math.min(b, x));
}

export function fitNote(t: Target, eq: Equipment): string {
  if (t.kind === 'planet') {
    if (eq.id === 'eye') return 'A bright point; binoculars or the Seestar show more.';
    if (eq.id === 'bino') return t.name === 'Jupiter' ? 'Look for up to four moons in a line beside it.' : 'A small disc at most; steady the binoculars.';
    return 'Use planetary mode. Small in the frame but rings and belts show.';
  }
  if (t.kind === 'moon') return eq.id === 'seestar' ? 'Fills most of the frame. Try the terminator for detail.' : 'Craters along the terminator stand out.';
  if (t.kind === 'star') return 'A point of light at any magnification. Good for focusing and alignment.';
  if (!t.size || !eq.fov) {
    if (eq.id === 'eye' && t.size && t.size[0] > 30) return 'Large and diffuse; look slightly to one side of it.';
    return eq.id === 'eye' ? 'Look slightly to one side of it to see it best.' : '';
  }
  const [maj, min] = t.size;
  const [fw, fh] = eq.fov;
  if (maj > fw * 1.15 || min > fh * 1.15) {
    const panels = Math.ceil(maj / (fw * 0.85)) * Math.ceil(min / (fh * 0.85));
    return eq.id === 'seestar'
      ? `About ${fmtSize(maj)} across, bigger than the S50 frame. Shoot a ${Math.max(2, panels)}-panel mosaic or frame the core.`
      : `About ${fmtSize(maj)} across, larger than the binocular view.`;
  }
  if (maj < fw * 0.08) return eq.id === 'seestar' ? `Small (${fmtSize(maj)}). Fits easily; crop afterwards.` : `Small (${fmtSize(maj)}). Look for a fuzzy star.`;
  return `About ${fmtSize(maj)} across. Fits the ${eq.id === 'seestar' ? 'S50 frame' : 'binocular view'} well.`;
}

export function fmtSize(arcmin: number): string {
  return arcmin >= 60 ? `${(arcmin / 60).toFixed(arcmin >= 120 ? 0 : 1)}°` : `${Math.round(arcmin)}′`;
}

/** Which targets are worth considering for the chosen equipment and sky. */
function candidates(cat: Catalog, eq: Equipment, skyLimit: number): Target[] {
  const out: Target[] = [];
  for (const t of cat.targets.values()) {
    if (t.kind === 'moon' || t.kind === 'planet') out.push(t);
    else if (t.kind === 'star') {
      if (t.mag !== null && t.mag <= 1.6) out.push(t);
    } else if (t.kind === 'dso') {
      const d = t.dso!;
      const eff = (t.mag ?? 12) + (d.group === 'galaxy' ? 0.8 : 0);
      if (eff <= eq.dsoLimit(skyLimit)) out.push(t);
    }
  }
  return out;
}

interface EvalCtx {
  tl: Timeline;
  night: Night;
  eq: Equipment;
  skyLimit: number;
  minAlt: number;
}

/** Curve, key times and score for one target. With `strict`, returns null for targets not worth listing. */
function evaluate(t: Target, c: EvalCtx, strict: boolean): PlanItem | null {
  const { tl, night, eq, skyLimit, minAlt } = c;
  const dark0 = night.darkStart.getTime();
  const dark1 = night.darkEnd.getTime();
  const twi0 = (night.civilDusk ?? night.sunset).getTime();
  const twi1 = (night.civilDawn ?? night.sunrise).getTime();
  const mid = new Date((dark0 + dark1) / 2);
  const n = tl.frames.length;
  const curve = new Float32Array(n);
  const raAt: number[] = [];
  const decAt: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = tl.frames[i];
    if (t.body !== undefined) {
      const e = f.bodyRaDec(t.body);
      raAt.push(e.ra);
      decAt.push(e.dec);
      curve[i] = f.radec(e.ra, e.dec).alt;
    } else {
      curve[i] = f.radec(t.ra!, t.dec!).alt;
    }
  }
  // Bright targets are fine in twilight; deep-sky needs real darkness.
  const bright = t.kind === 'planet' || t.kind === 'moon' || t.kind === 'star';
  const w0 = bright ? twi0 : dark0;
  const w1 = bright ? twi1 : dark1;
  const pk = peak(curve, tl, w0, w1);
  if (strict && pk.value < (bright ? 8 : Math.min(minAlt, 25))) return null;
  if (t.kind === 'planet') {
    const m = bodyMag(t.body!, mid);
    t.mag = Math.round(m * 10) / 10;
    if (strict && m > (eq.id === 'eye' ? skyLimit - 0.5 : eq.dsoLimit(skyLimit))) return null;
  }

  let usable = 0;
  let bestStart: number | null = null;
  let bestEnd: number | null = null;
  for (let i = 0; i < n; i++) {
    const ms = tl.start + i * tl.stepMs;
    if (ms < w0 || ms > w1) continue;
    if (curve[i] >= minAlt) {
      usable += tl.stepMs / 60e3;
      if (bestStart === null) bestStart = ms;
      bestEnd = ms;
    }
  }

  const iPk = Math.min(n - 1, Math.max(0, Math.round((pk.ms - tl.start) / tl.stepMs)));
  const ra = t.body !== undefined ? raAt[iPk] : t.ra!;
  const dec = t.body !== undefined ? decAt[iPk] : t.dec!;
  const moonSep = t.kind === 'moon' ? 0 : separation(ra, dec, sampleAt(tl.moonRa, tl, pk.ms), sampleAt(tl.moonDec, tl, pk.ms));
  const moonUpAtPeak = sampleAt(tl.moonAlt, tl, pk.ms) > 0;

  // ---- score: altitude, time available, brightness margin, popularity; less for moonlight and poor fit
  const qAlt = clamp((pk.value - 15) / 50);
  const qDur = clamp(usable / 180);
  let qMag = 1;
  if (t.kind === 'dso') qMag = clamp((eq.dsoLimit(skyLimit) - (t.mag ?? 12)) / 3.5);
  let pop = 0.15;
  if (t.kind === 'planet') pop = PLANET_POP[t.name] ?? 0.5;
  else if (t.kind === 'moon') pop = eq.id === 'eye' ? 1 : 0.9;
  else if (t.kind === 'dso') pop = (t.dso!.m ? 0.7 : 0.2) + (t.dso!.name ? 0.3 : 0);
  let moonFactor = 1;
  if (t.kind === 'dso' && moonUpAtPeak) {
    const f = moonInfo(new Date(pk.ms)).fraction;
    moonFactor = 1 - 0.7 * f * (1 - clamp(moonSep / 100));
  }
  let fitFactor = 1;
  if (t.kind === 'dso' && eq.fov && t.size) {
    if (t.size[0] > eq.fov[0] * 1.6) fitFactor = t.dso!.m ? 0.92 : 0.8;
    else if (t.size[0] < eq.fov[0] * 0.04) fitFactor = 0.8;
  }
  if (t.kind === 'star') fitFactor = 0.55;
  const score = Math.round(100 * (0.3 * qAlt + 0.25 * qDur + 0.2 * qMag + 0.25 * pop) * moonFactor * fitFactor);

  return {
    target: t, curve, peak: pk,
    rise: crossings(curve, tl, 0, 1)[0] ?? null,
    set: crossings(curve, tl, 0, -1)[0] ?? null,
    clears: crossings(curve, tl, minAlt, 1)[0] ?? null,
    drops: crossings(curve, tl, minAlt, -1)[0] ?? null,
    minutesUsable: usable, bestStart, bestEnd,
    moonSep, moonUpAtPeak, score,
    fit: fitNote(t, eq),
  };
}

export function buildPlan(
  cat: Catalog, night: Night, site: Site, equipment: EquipmentId, skyLimit: number, minAlt: number,
): Plan {
  const eq = EQUIPMENT[equipment];
  const tl = buildTimeline(night.sunset, night.sunrise, site, 5);
  const ctx: EvalCtx = { tl, night, eq, skyLimit, minAlt };
  const items: PlanItem[] = [];
  for (const t of candidates(cat, eq, skyLimit)) {
    const it = evaluate(t, ctx, true);
    if (it) items.push(it);
  }
  items.sort((a, b) => b.score - a.score);
  return { night, timeline: tl, items, passes: [], equipment, minAlt, skyLimit };
}

/** A plan item for any target, listed or not (used by the detail view). */
export function itemFor(t: Target, plan: Plan): PlanItem {
  const found = plan.items.find((i) => i.target.id === t.id);
  if (found) return found;
  return evaluate(t, { tl: plan.timeline, night: plan.night, eq: EQUIPMENT[plan.equipment], skyLimit: plan.skyLimit, minAlt: plan.minAlt }, false)!;
}

export function passItems(passes: Pass[], tl: Timeline): PlanItem[] {
  return passes.map((p) => {
    const t: Target = {
      id: `sat${p.norad}`, kind: 'sat', name: p.name, label: p.name, type: 'Satellite',
      cat: `NORAD ${p.norad}`, mag: Math.round(p.mag * 10) / 10, size: null, norad: p.norad,
    };
    const curve = new Float32Array(tl.frames.length).fill(-90);
    return {
      target: t, curve, peak: { ms: p.max.ms, value: p.max.alt },
      rise: p.rise.ms, set: p.set.ms, clears: p.visStart?.ms ?? null, drops: p.visEnd?.ms ?? null,
      minutesUsable: 0, bestStart: p.visStart?.ms ?? null, bestEnd: p.visEnd?.ms ?? null,
      moonSep: 180, moonUpAtPeak: false, score: Math.round(60 - p.mag * 8), fit: '', pass: p,
    };
  });
}

// ------------------------------------------------------- status for "now"

export type Tone = 'good' | 'soon' | 'low' | 'sat' | 'done' | '';

export interface Status {
  line: string;
  badge: string;
  tone: Tone;
  altNow: number;
  /** Time an alert for this item would refer to (it clears the minimum altitude, or a pass starts). */
  alertAt: number | null;
  /** Wording for that event, e.g. "clears 30° at 11:25 PM". */
  alertWhat: string | null;
}

export function statusFor(it: PlanItem, plan: Plan, now: number): Status {
  const tl = plan.timeline;
  const minAlt = plan.minAlt;
  if (it.pass) {
    const p = it.pass;
    const a = p.visStart!, b = p.visEnd!;
    const dir = `${compassShort(a.az)} → ${compassShort(b.az)}`;
    if (now > b.ms) return { line: `Passed at ${fmtTime(a.ms)}`, badge: '', tone: 'done', altNow: -90, alertAt: null, alertWhat: null };
    if (now >= a.ms) return { line: `Visible now · max ${Math.round(p.max.alt)}° · ${dir}`, badge: 'Now', tone: 'good', altNow: p.max.alt, alertAt: null, alertWhat: null };
    return {
      line: `${fmtTime(a.ms)} · max ${Math.round(p.max.alt)}° · ${dir}`,
      badge: a.ms - now < 3600e3 ? `In ${fmtDur(a.ms - now)}` : 'Satellite',
      tone: a.ms - now < 3600e3 ? 'soon' : 'sat', altNow: -90, alertAt: a.ms,
      alertWhat: `appears at ${fmtTime(a.ms)} in the ${compassShort(a.az)}`,
    };
  }
  const inWindow = now >= tl.start && now <= tl.start + tl.stepMs * (it.curve.length - 1);
  const altNow = inWindow ? sampleAt(it.curve, tl, now) : -90;
  const pk = it.peak;
  const futureClears = crossings(it.curve, tl, minAlt, 1).find((ms) => ms > now) ?? null;
  const futureDrops = crossings(it.curve, tl, minAlt, -1).find((ms) => ms > now) ?? null;
  const futureRise = crossings(it.curve, tl, 0, 1).find((ms) => ms > now) ?? null;
  const futureSet = crossings(it.curve, tl, 0, -1).find((ms) => ms > now) ?? null;
  const peakStr = `peaks ${Math.round(pk.value)}° at ${fmtTime(pk.ms)}`;

  if (inWindow && altNow >= minAlt) {
    if (pk.ms > now + 10 * 60e3) {
      const nearPeak = pk.ms - now < 75 * 60e3;
      return { line: `Up now · ${peakStr}`, badge: nearPeak || it.score >= 70 ? 'Best now' : 'Up now', tone: 'good', altNow, alertAt: null, alertWhat: null };
    }
    const until = futureDrops ? `below ${minAlt}° at ${fmtTime(futureDrops)}` : 'up until dawn';
    return { line: `Up now · ${Math.round(altNow)}° · ${until}`, badge: futureDrops && futureDrops - now < 3600e3 ? 'Catch it soon' : 'Up now', tone: 'good', altNow, alertAt: null, alertWhat: null };
  }
  if (futureClears) {
    const inMs = futureClears - now;
    return {
      line: `Clears ${minAlt}° at ${fmtTime(futureClears)} · in ${fmtDur(inMs)}`,
      badge: inMs <= 3 * 3600e3 ? 'Coming up' : '', tone: inMs <= 3 * 3600e3 ? 'soon' : '', altNow, alertAt: futureClears,
      alertWhat: `clears ${minAlt}° at ${fmtTime(futureClears)}`,
    };
  }
  if (inWindow && altNow > 0) {
    return { line: futureSet ? `Low · ${Math.round(altNow)}° · sets ${fmtTime(futureSet)}` : `Low · ${Math.round(altNow)}° · ${peakStr}`, badge: 'Low', tone: 'low', altNow, alertAt: null, alertWhat: null };
  }
  if (futureRise) {
    return { line: `Rises ${fmtTime(futureRise)} · ${peakStr}`, badge: '', tone: '', altNow, alertAt: futureRise, alertWhat: `rises at ${fmtTime(futureRise)}` };
  }
  if (now < tl.start) {
    return { line: it.clears ? `Clears ${minAlt}° at ${fmtTime(it.clears)} · ${peakStr}` : peakStr, badge: '', tone: '', altNow, alertAt: it.clears, alertWhat: it.clears ? `clears ${minAlt}° at ${fmtTime(it.clears)}` : null };
  }
  return { line: 'Done for tonight', badge: '', tone: 'done', altNow, alertAt: null, alertWhat: null };
}

function compassShort(az: number): string {
  const c = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return c[Math.round((((az % 360) + 360) % 360) / 45) % 8];
}
