// HTML for the Tonight list and the object detail panel. Event handling lives in main.ts
// (elements carry data-action / data-id attributes).
import type { Target } from '../astro/catalog';
import { compass, sampleAt, type Night } from '../astro/engine';
import { EQUIPMENT, fitNote, fmtSize, itemFor, statusFor, type EquipmentId, type Plan, type PlanItem, type Status } from '../astro/plan';
import type { Pass } from '../astro/satellites';
import type { Alert } from '../state';
import { cloudAt, type CloudForecast } from '../weather';
import { esc, fmtDay, fmtDur, fmtMag, fmtTime } from './format';

export type Category = 'all' | 'planets' | 'dso' | 'stars' | 'sats';

export const KIND_COLOR: Record<string, string> = {
  star: '#F4F1E8', planet: '#FFCF8A', moon: '#EDEAE0', dso: '#B49CFF', sat: '#7FB3FF',
};

const ICON = {
  bell: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  target: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>',
  cal: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
};

function dot(t: Target): string {
  const c = KIND_COLOR[t.kind];
  if (t.kind === 'dso') return `<span class="dot dot-ring" style="border-color:${c}" aria-hidden="true"></span>`;
  if (t.kind === 'sat') return `<span class="dot dot-diamond" style="background:${c}" aria-hidden="true"></span>`;
  return `<span class="dot" style="background:${t.color ?? c}" aria-hidden="true"></span>`;
}

export function subLine(t: Target): string {
  const bits = [t.type];
  if (t.cat && t.kind !== 'planet' && t.kind !== 'moon') bits.push(t.cat);
  if (t.mag !== null && t.kind !== 'moon') bits.push(`mag ${fmtMag(t.mag)}${t.kind === 'sat' ? ' (est.)' : ''}`);
  if (t.size && t.kind === 'dso') bits.push(fmtSize(t.size[0]));
  return bits.join(' · ');
}

function badge(s: Status): string {
  if (!s.badge) return '';
  return `<span class="badge badge-${s.tone || 'plain'}">${esc(s.badge)}</span>`;
}

// ------------------------------------------------------------- timeline

function nightTimeline(plan: Plan, now: number, clouds: CloudForecast | null): string {
  const n = plan.night;
  const t0 = n.sunset.getTime();
  const t1 = n.sunrise.getTime();
  const W = 340;
  const x = (ms: number) => Math.max(0, Math.min(W, ((ms - t0) / (t1 - t0)) * W));
  const seg = (a: Date | null, b: Date | null, fill: string) => (a && b ? `<rect x="${x(a.getTime()).toFixed(1)}" y="14" width="${(x(b.getTime()) - x(a.getTime())).toFixed(1)}" height="14" fill="${fill}"/>` : '');
  let svg = `<rect x="0" y="14" width="${W}" height="14" rx="7" fill="#3A4466"/>`;
  svg += seg(n.civilDusk, n.civilDawn, '#2A3352');
  svg += seg(n.nauticalDusk, n.nauticalDawn, '#1D2540');
  svg += seg(n.dusk, n.dawn, '#111830');
  // Moon above the horizon
  const tl = plan.timeline;
  let runStart: number | null = null;
  for (let i = 0; i < tl.moonAlt.length; i++) {
    const ms = tl.start + i * tl.stepMs;
    const up = tl.moonAlt[i] > 0;
    if (up && runStart === null) runStart = ms;
    if ((!up || i === tl.moonAlt.length - 1) && runStart !== null) {
      svg += `<rect x="${x(runStart).toFixed(1)}" y="31" width="${Math.max(2, x(ms) - x(runStart)).toFixed(1)}" height="4" rx="2" fill="#D9D4C3" opacity="0.8"/>`;
      runStart = null;
    }
  }
  // Clouds
  if (clouds) {
    for (let ms = t0; ms < t1; ms += 3600e3) {
      const c = cloudAt(clouds, ms + 1800e3);
      if (c === null || c < 15) continue;
      svg += `<rect x="${x(ms).toFixed(1)}" y="8" width="${(x(ms + 3600e3) - x(ms)).toFixed(1)}" height="4" fill="#C9D1E0" opacity="${(0.2 + c / 140).toFixed(2)}"/>`;
    }
  }
  // Hour ticks every two hours
  const firstHour = new Date(t0);
  firstHour.setMinutes(0, 0, 0);
  for (let ms = firstHour.getTime() + 3600e3; ms < t1; ms += 3600e3) {
    const h = new Date(ms).getHours();
    if (h % 2 || x(ms) < 14 || x(ms) > W - 14) continue;
    svg += `<text x="${x(ms).toFixed(1)}" y="50" text-anchor="middle" class="tl-txt">${esc(fmtTime(ms).replace(':00', ''))}</text>`;
  }
  if (now >= t0 && now <= t1) {
    svg += `<line x1="${x(now).toFixed(1)}" y1="6" x2="${x(now).toFixed(1)}" y2="38" stroke="#F2B544" stroke-width="2"/>`;
  }
  const label = `Night from sunset ${fmtTime(t0)} to sunrise ${fmtTime(t1)}. ${n.fullyDark ? `Fully dark ${fmtTime(n.darkStart)} to ${fmtTime(n.darkEnd)}.` : 'It does not get fully dark tonight.'}`;
  return `<svg class="timeline" viewBox="0 -2 ${W} 56" role="img" aria-label="${esc(label)}">${svg}</svg>
  <div class="tl-legend" aria-hidden="true"><span><i class="lg lg-dark"></i>Dark</span><span><i class="lg lg-moon"></i>Moon up</span>${clouds ? '<span><i class="lg lg-cloud"></i>Clouds</span>' : ''}<span><i class="lg lg-now"></i>Now</span></div>`;
}

function spark(it: PlanItem, plan: Plan, now: number, w = 92, h = 32): string {
  const tl = plan.timeline;
  const n = it.curve.length;
  const y = (alt: number) => h - 2 - (Math.max(0, Math.min(90, alt)) / 90) * (h - 4);
  const tx = (ms: number) => ((ms - tl.start) / (tl.stepMs * (n - 1))) * w;
  let pts = '';
  if (it.pass) {
    const p = it.pass;
    pts = `${tx(p.rise.ms).toFixed(1)},${y(0)} ${tx(p.max.ms).toFixed(1)},${y(p.max.alt).toFixed(1)} ${tx(p.set.ms).toFixed(1)},${y(0)}`;
  } else {
    const step = Math.max(1, Math.floor(n / 46));
    for (let i = 0; i < n; i += step) pts += `${((i / (n - 1)) * w).toFixed(1)},${y(it.curve[i]).toFixed(1)} `;
    pts += `${w},${y(it.curve[n - 1]).toFixed(1)}`;
  }
  const nowX = now >= tl.start && now <= tl.start + tl.stepMs * (n - 1) ? tx(now) : -10;
  const c = KIND_COLOR[it.target.kind];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <line x1="0" y1="${h - 2}" x2="${w}" y2="${h - 2}" stroke="#2A3350"/>
    <line x1="0" y1="${y(plan.minAlt).toFixed(1)}" x2="${w}" y2="${y(plan.minAlt).toFixed(1)}" stroke="#2A3350" stroke-dasharray="2 3"/>
    <line x1="${nowX.toFixed(1)}" y1="0" x2="${nowX.toFixed(1)}" y2="${h}" stroke="#F2B544" stroke-opacity="0.75"/>
    <polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round"/>
  </svg>`;
}

// ----------------------------------------------------------- Tonight list

export interface TonightInput {
  plan: Plan | null;
  now: number;
  equipment: EquipmentId;
  category: Category;
  alerts: Alert[];
  clouds: CloudForecast | null;
  satStatus: string;
  selectedId: string | null;
  needsLocation: boolean;
}

export function renderTonight(s: TonightInput): string {
  if (s.needsLocation) {
    return `<div class="panel-head"><h2>Tonight</h2></div>
      <div class="empty"><p>Set your observing location to see what's up tonight.</p>
      <button class="btn btn-primary" data-action="open-settings">Set location</button></div>`;
  }
  if (!s.plan) return `<div class="panel-head"><h2>Tonight</h2></div><div class="empty"><p>Working out tonight's sky…</p></div>`;
  const plan = s.plan;
  const n = plan.night;
  const darkLine = n.fullyDark
    ? `Dark ${fmtTime(n.darkStart)} – ${fmtTime(n.darkEnd)} · ${fmtDur(n.darkEnd.getTime() - n.darkStart.getTime())}`
    : `Never fully dark · darkest ${fmtTime(n.darkStart)} – ${fmtTime(n.darkEnd)}`;
  const moonLine = `Moon ${Math.round(n.moonFraction * 100)}% lit${n.moonrise ? ` · rises ${fmtTime(n.moonrise)}` : ''}${n.moonset ? ` · sets ${fmtTime(n.moonset)}` : ''}`;
  const cloudNow = cloudAt(s.clouds, s.now);

  const eqButtons = (Object.keys(EQUIPMENT) as EquipmentId[]).map((id) => {
    const on = id === s.equipment;
    return `<button type="button" class="seg-btn${on ? ' on' : ''}" aria-pressed="${on}" data-action="equip" data-id="${id}">${esc(EQUIPMENT[id].label)}</button>`;
  }).join('');
  const cats: [Category, string][] = [['all', 'All'], ['planets', 'Moon & planets'], ['dso', 'Deep sky'], ['stars', 'Stars'], ['sats', 'Satellites']];
  const catButtons = cats.map(([id, label]) => `<button type="button" class="chip${id === s.category ? ' on' : ''}" aria-pressed="${id === s.category}" data-action="category" data-id="${id}">${label}</button>`).join('');

  let items: PlanItem[] = [];
  const pick = (k: Category) => {
    if (k === 'planets') return plan.items.filter((i) => i.target.kind === 'planet' || i.target.kind === 'moon');
    if (k === 'dso') return plan.items.filter((i) => i.target.kind === 'dso');
    if (k === 'stars') return plan.items.filter((i) => i.target.kind === 'star');
    if (k === 'sats') return s.equipment === 'seestar' ? [] : plan.passes.filter((p) => p.pass!.visEnd!.ms > s.now);
    return [];
  };
  if (s.category === 'all') {
    const objs = plan.items.filter((i) => i.target.kind !== 'star');
    const passes = s.equipment === 'seestar' ? [] : plan.passes.filter((p) => p.pass!.visEnd!.ms > s.now).slice(0, 4);
    items = [...objs.slice(0, 30), ...passes];
  } else items = pick(s.category);

  // Rank: things happening soon and good things up now first; finished ones last.
  const withStatus = items.map((it) => ({ it, st: statusFor(it, plan, s.now) }));
  const rank = (x: { it: PlanItem; st: Status }) => {
    let r = x.it.score;
    if (x.st.tone === 'good') r += 25;
    if (x.st.tone === 'soon') r += 15;
    if (x.st.tone === 'done') r -= 200;
    if (x.st.tone === 'low') r -= 20;
    return r;
  };
  if (s.category === 'sats') withStatus.sort((a, b) => a.it.pass!.visStart!.ms - b.it.pass!.visStart!.ms);
  else withStatus.sort((a, b) => rank(b) - rank(a));

  const alertIds = new Set(s.alerts.filter((a) => a.at > s.now - 60e3).map((a) => a.targetId));
  const list = withStatus.map(({ it, st }) => {
    const t = it.target;
    const on = alertIds.has(t.id);
    const canAlert = st.alertAt !== null && st.alertAt > s.now;
    const sel = t.id === s.selectedId;
    return `<li class="item${sel ? ' selected' : ''}${st.tone === 'done' ? ' done' : ''}">
      <button type="button" class="item-main" data-action="select" data-id="${esc(t.id)}" aria-current="${sel}">
        ${dot(t)}
        <span class="item-text">
          <span class="item-title"><span class="item-name">${esc(t.name)}</span>${badge(st)}</span>
          <span class="item-sub">${esc(subLine(t))}</span>
          <span class="item-status">${esc(st.line)}</span>
        </span>
        ${spark(it, plan, s.now)}
      </button>
      ${canAlert || on ? `<button type="button" class="icon-btn bell${on ? ' on' : ''}" data-action="quick-alert" data-id="${esc(t.id)}" aria-pressed="${on}"
        aria-label="${on ? 'Remove alert for' : 'Alert me about'} ${esc(t.name)}">${ICON.bell}</button>` : '<span class="bell-spacer" aria-hidden="true"></span>'}
    </li>`;
  }).join('');

  const empty = s.category === 'sats'
    ? `<li class="empty-row">${esc(s.equipment === 'seestar' ? 'Satellite passes are too fast for the Seestar. Switch to Naked eye or Binoculars.' : s.satStatus || 'No bright passes tonight.')}</li>`
    : '<li class="empty-row">Nothing in this group is well placed tonight.</li>';

  const upcoming = s.alerts.filter((a) => a.at > s.now - 60e3).sort((a, b) => a.at - b.at);
  const alertsBlock = upcoming.length
    ? `<section class="alerts" aria-label="Your alerts"><h3>Your alerts</h3><ul>${upcoming.map((a) => `<li><span><strong>${esc(a.name)}</strong> · ${esc(a.what)} · alert ${fmtTime(a.at)}</span><button type="button" class="link-btn" data-action="remove-alert" data-id="${esc(a.id)}">Remove</button></li>`).join('')}</ul></section>`
    : '';

  return `<div class="panel-head">
      <h2>Tonight <span class="muted small">${esc(fmtDay(n.sunset))}</span></h2>
      <p class="muted">${esc(darkLine)}</p>
      <p class="muted">${esc(moonLine)}${cloudNow !== null ? ` · Clouds now ${cloudNow}%` : ''}</p>
    </div>
    ${nightTimeline(plan, s.now, s.clouds)}
    <div class="seg" role="group" aria-label="Equipment">${eqButtons}</div>
    <div class="chips" role="group" aria-label="Show">${catButtons}</div>
    ${alertsBlock}
    <ul class="list">${list || empty}</ul>
    <p class="fine">Curves run sunset to sunrise. Dashed line is ${plan.minAlt}°, the amber line is now.</p>`;
}

// ---------------------------------------------------------------- detail

export interface DetailInput {
  target: Target | null;
  plan: Plan | null;
  now: number;
  live: { alt: number; az: number; mag?: number; sunlit?: boolean } | null;
  passes: Pass[];
  alerts: Alert[];
  leadMin: number;
  notify: 'granted' | 'denied' | 'default' | 'unsupported';
  equipment: EquipmentId;
  layout: 'phone' | 'tablet' | 'desktop';
}

function altChart(it: PlanItem, plan: Plan, now: number): string {
  const tl = plan.timeline;
  const n = it.curve.length;
  const W = 340, H = 190, L = 30, T = 18, B = 22, R = 8;
  const pw = W - L - R, ph = H - T - B;
  const t0 = tl.start, t1 = tl.start + tl.stepMs * (n - 1);
  const x = (ms: number) => L + ((ms - t0) / (t1 - t0)) * pw;
  const y = (alt: number) => T + ph - (Math.max(0, Math.min(90, alt)) / 90) * ph;
  const night = plan.night;
  let s = '';
  // twilight shading
  const shade = (a: number, b: number, fill: string) => `<rect x="${x(a).toFixed(1)}" y="${T}" width="${Math.max(0, x(b) - x(a)).toFixed(1)}" height="${ph}" fill="${fill}"/>`;
  s += shade(t0, night.darkStart.getTime(), '#1E2540');
  s += shade(night.darkEnd.getTime(), t1, '#1E2540');
  if (it.bestStart && it.bestEnd) s += shade(it.bestStart, it.bestEnd, 'rgba(242,181,68,0.10)');
  for (const a of [0, 30, 60, 90]) {
    const isMin = a === plan.minAlt;
    s += `<line x1="${L}" y1="${y(a)}" x2="${W - R}" y2="${y(a)}" stroke="${a === 0 ? '#3B4566' : '#222B44'}"/>`;
    s += `<text x="${L - 5}" y="${y(a) + 3}" text-anchor="end" class="ch-txt${isMin ? ' accent' : ''}">${a}°</text>`;
  }
  if (![0, 30, 60, 90].includes(plan.minAlt)) {
    s += `<text x="${L - 5}" y="${y(plan.minAlt) + 3}" text-anchor="end" class="ch-txt accent">${plan.minAlt}°</text>`;
  }
  s += `<line x1="${L}" y1="${y(plan.minAlt)}" x2="${W - R}" y2="${y(plan.minAlt)}" stroke="#F2B544" stroke-opacity="0.6" stroke-dasharray="3 4"/>`;
  // moonrise/set markers
  for (const m of [night.moonrise, night.moonset]) {
    if (!m || m.getTime() < t0 || m.getTime() > t1) continue;
    s += `<line x1="${x(m.getTime())}" y1="${T}" x2="${x(m.getTime())}" y2="${T + ph}" stroke="#C9D1E0" stroke-opacity="0.45" stroke-dasharray="2 3"/>`;
    s += `<text x="${x(m.getTime())}" y="${T - 5}" text-anchor="middle" class="ch-txt">${m === night.moonrise ? 'Moonrise' : 'Moonset'}</text>`;
  }
  // curve
  let pts = '';
  for (let i = 0; i < n; i++) {
    const ms = tl.start + i * tl.stepMs;
    pts += `${x(ms).toFixed(1)},${y(it.curve[i]).toFixed(1)} `;
  }
  const c = KIND_COLOR[it.target.kind];
  s += `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/>`;
  if (it.peak.value > 0) {
    s += `<circle cx="${x(it.peak.ms)}" cy="${y(it.peak.value)}" r="4" fill="${c}"/>`;
    const lx = Math.max(L + 30, Math.min(W - R - 30, x(it.peak.ms)));
    s += `<text x="${lx}" y="${Math.max(T + 10, y(it.peak.value) - 8)}" text-anchor="middle" class="ch-txt strong">${Math.round(it.peak.value)}° · ${esc(fmtTime(it.peak.ms))}</text>`;
  }
  if (now >= t0 && now <= t1) {
    s += `<line x1="${x(now)}" y1="${T}" x2="${x(now)}" y2="${T + ph}" stroke="#F2B544" stroke-width="1.5"/>`;
    s += `<text x="${x(now)}" y="${H - 6}" text-anchor="middle" class="ch-txt accent strong">Now</text>`;
  }
  // hour labels
  const first = new Date(t0);
  first.setMinutes(0, 0, 0);
  for (let ms = first.getTime() + 3600e3; ms < t1; ms += 3600e3) {
    const hr = new Date(ms).getHours();
    if (hr % 3) continue;
    if (now >= t0 && now <= t1 && Math.abs(x(ms) - x(now)) < 22) continue;
    s += `<text x="${x(ms)}" y="${H - 6}" text-anchor="middle" class="ch-txt">${esc(fmtTime(ms).replace(':00', ''))}</text>`;
  }
  const aria = `Altitude through the night. Peaks at ${Math.round(it.peak.value)} degrees at ${fmtTime(it.peak.ms)}.${it.bestStart && it.bestEnd ? ` Above ${plan.minAlt} degrees in the dark from ${fmtTime(it.bestStart)} to ${fmtTime(it.bestEnd)}.` : ''}`;
  return `<svg class="alt-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${s}</svg>`;
}

function fovFigure(t: Target, eq: EquipmentId): string {
  const fov = EQUIPMENT[eq].fov;
  if (!fov || !t.size) return '';
  const [maj, min] = t.size;
  const span = Math.max(maj * 1.1, fov[0] * 1.15);
  const W = 150, H = 110;
  const k = (W - 10) / span;
  const cx = W / 2, cy = H / 2;
  const ow = (maj * k) / 2, oh = (min * k) / 2;
  const fw = fov[0] * k, fh = fov[1] * k;
  const frame = fov[0] === fov[1]
    ? `<circle cx="${cx}" cy="${cy}" r="${fw / 2}" fill="none" stroke="#F2B544" stroke-width="2"/>`
    : `<rect x="${cx - fw / 2}" y="${cy - fh / 2}" width="${fw}" height="${fh}" fill="none" stroke="#F2B544" stroke-width="2" rx="2"/>`;
  return `<svg class="fov" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${EQUIPMENT[eq].label} field of view compared with the object's size`)}">
    <ellipse cx="${cx}" cy="${cy}" rx="${Math.max(2, ow)}" ry="${Math.max(2, oh)}" fill="#B49CFF" fill-opacity="0.28"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${Math.max(1, ow * 0.4)}" ry="${Math.max(1, oh * 0.4)}" fill="#B49CFF" fill-opacity="0.35"/>
    ${frame}
  </svg>`;
}

export function renderDetail(d: DetailInput): string {
  const closeBtn = d.layout === 'desktop' ? '' : `<button type="button" class="back-btn" data-action="close-detail">${d.layout === 'phone' ? ICON.close : ICON.back}<span>${d.layout === 'phone' ? 'Close' : 'Tonight'}</span></button>`;
  if (!d.target || !d.plan) {
    return `<div class="empty"><p>Tap anything in the sky or the Tonight list to see when it's best placed.</p></div>`;
  }
  const t = d.target;
  const plan = d.plan;
  const it = t.kind === 'sat' ? plan.passes.find((p) => p.target.id === t.id) ?? null : itemFor(t, plan);
  const st = it ? statusFor(it, plan, d.now) : null;
  const live = d.live;

  let html = `<div class="detail-head">${closeBtn}
    <h2>${esc(t.name)}</h2>
    <p class="muted">${esc(subLine(t))}</p>
    ${st ? `<p class="status-line">${badge(st)}<span>${esc(st.line)}</span></p>` : ''}
  </div>`;

  // Right now
  html += `<section class="card" aria-label="Right now"><div class="stats">
    <div class="stat"><span class="stat-k">Altitude now</span><span class="stat-v">${live ? `${Math.round(live.alt)}°` : '—'}</span></div>
    <div class="stat"><span class="stat-k">Direction</span><span class="stat-v">${live ? `${Math.round(live.az)}° ${compass(live.az)}` : '—'}</span></div>
    <div class="stat"><span class="stat-k">Magnitude</span><span class="stat-v">${fmtMag(live?.mag ?? t.mag)}</span></div>
  </div>${live && live.alt < 0 ? '<p class="fine">Below the horizon right now.</p>' : ''}</section>`;

  if (t.kind === 'sat') {
    const mine = d.passes.filter((p) => `sat${p.norad}` === t.id && p.visEnd!.ms > d.now);
    html += `<section class="card"><h3>Visible passes tonight</h3>`;
    if (!mine.length) html += '<p class="fine">No more visible passes tonight.</p>';
    else {
      html += '<ul class="passes">' + mine.map((p) => `<li>
        <div><strong>${esc(fmtTime(p.visStart!.ms))}</strong> – ${esc(fmtTime(p.visEnd!.ms))}</div>
        <div class="muted">Appears ${Math.round(p.visStart!.alt)}° ${compass(p.visStart!.az)} · max ${Math.round(p.max.alt)}° ${compass(p.max.az)} at ${esc(fmtTime(p.max.ms))} · ends ${Math.round(p.visEnd!.alt)}° ${compass(p.visEnd!.az)}</div>
        <div class="muted">Brightest about mag ${fmtMag(p.mag)} (estimate)</div></li>`).join('') + '</ul>';
    }
    html += `</section>`;
    if (mine[0]) html += alertCard(t, mine[0].visStart!.ms, `appears at ${fmtTime(mine[0].visStart!.ms)} in the ${compass(mine[0].visStart!.az)}`, d);
    html += actions(t, live, mine.length > 0);
    return html;
  }

  if (it) {
    html += `<section class="card" aria-label="Altitude tonight"><div class="card-head"><h3>Altitude tonight</h3>${it.bestStart && it.bestEnd ? `<span class="muted small">Best ${esc(fmtTime(it.bestStart))} – ${esc(fmtTime(it.bestEnd))}</span>` : `<span class="muted small">Never above ${plan.minAlt}° while dark</span>`}</div>
      ${altChart(it, plan, d.now)}</section>`;
    const cell = (k: string, v: string) => `<div class="stat"><span class="stat-k">${k}</span><span class="stat-v sm">${v}</span></div>`;
    const azAt = (ms: number | null) => {
      if (!ms) return '';
      const f = plan.timeline.frames[Math.round((ms - plan.timeline.start) / plan.timeline.stepMs)];
      if (!f) return '';
      const hp = t.body !== undefined ? f.body(t.body) : f.radec(t.ra!, t.dec!);
      return ` · ${compass(hp.az)}`;
    };
    const moonAlt = sampleAt(plan.timeline.moonAlt, plan.timeline, it.peak.ms);
    html += `<section class="stats grid2" aria-label="Key times">
      ${cell('Rises', it.rise ? esc(fmtTime(it.rise)) + azAt(it.rise) : it.curve[0] > 0 ? 'Up at sunset' : 'Not tonight')}
      ${cell(`Above ${plan.minAlt}°`, it.clears ? esc(fmtTime(it.clears)) : it.curve[0] >= plan.minAlt ? 'At sunset' : 'Never')}
      ${cell('Peak', `${Math.round(it.peak.value)}° at ${esc(fmtTime(it.peak.ms))}${azAt(it.peak.ms)}`)}
      ${cell('Sets', it.set ? esc(fmtTime(it.set)) + azAt(it.set) : it.curve[it.curve.length - 1] > 0 ? 'Up at sunrise' : '—')}
      ${t.kind !== 'moon' ? cell('Moon at peak', moonAlt > 0 ? `${Math.round(it.moonSep)}° away, ${Math.round(plan.night.moonFraction * 100)}% lit` : 'Below horizon') : cell('Phase', `${Math.round(plan.night.moonFraction * 100)}% lit`)}
      ${cell('Dark time above ' + plan.minAlt + '°', it.minutesUsable ? fmtDur(it.minutesUsable * 60e3) : 'None')}
    </section>`;
  }

  // Equipment fit
  const notes = (Object.keys(EQUIPMENT) as EquipmentId[]).map((eq) => {
    const note = fitNote(t, EQUIPMENT[eq]);
    return note ? `<p class="${eq === d.equipment ? '' : 'muted'}"><strong>${esc(EQUIPMENT[eq].label)}:</strong> ${esc(note)}</p>` : '';
  }).join('');
  html += `<section class="card fit" aria-label="Equipment fit">${fovFigure(t, d.equipment)}<div class="fit-notes">${notes}</div></section>`;

  if (st?.alertAt && st.alertWhat && st.alertAt > d.now) html += alertCard(t, st.alertAt, st.alertWhat, d);
  html += actions(t, live);
  return html;
}

function alertCard(t: Target, eventMs: number, what: string, d: DetailInput): string {
  const existing = d.alerts.find((a) => a.targetId === t.id && a.at > d.now - 60e3);
  const leadOpts = [5, 15, 30, 60].map((m) => `<option value="${m}"${m === d.leadMin ? ' selected' : ''}>${m < 60 ? `${m} min` : '1 hour'} before</option>`).join('');
  const notifyNote = d.notify === 'denied'
    ? 'Notifications are blocked for this site in your browser settings. A calendar event still works.'
    : d.notify === 'unsupported' ? 'This browser can’t show notifications. Use a calendar event instead.'
    : 'Device alerts fire while Sky Planner is open. A calendar event reminds you even when it’s closed.';
  return `<section class="card" aria-label="Alert">
    <h3>Alert me</h3>
    <p class="muted">${esc(t.name)} ${esc(what)}.</p>
    <label class="row-label">Lead time
      <select data-action="lead">${leadOpts}</select>
    </label>
    <div class="btn-row">
      <button type="button" class="btn ${existing ? '' : 'btn-primary'}" data-action="toggle-alert" data-id="${esc(t.id)}" data-at="${eventMs}" data-what="${esc(what)}" aria-pressed="${!!existing}">${ICON.bell}<span>${existing ? `Alert set for ${esc(fmtTime(existing.at))}` : 'Alert on this device'}</span></button>
      <button type="button" class="btn" data-action="ics" data-id="${esc(t.id)}" data-at="${eventMs}" data-what="${esc(what)}">${ICON.cal}<span>Add to calendar</span></button>
    </div>
    <p class="fine">${esc(notifyNote)}</p>
  </section>`;
}

function actions(t: Target, live: DetailInput['live'], hasPass = false): string {
  const up = !!live && live.alt > -2;
  const label = up ? 'Find in sky' : hasPass ? 'Show the pass in the sky' : 'Below horizon now';
  return `<div class="btn-row sticky-actions">
    <button type="button" class="btn btn-primary" data-action="find" data-id="${esc(t.id)}" ${up || hasPass ? '' : 'disabled'}>${ICON.target}<span>${label}</span></button>
  </div>`;
}

export function nightSummary(n: Night): string {
  return n.fullyDark ? `Dark ${fmtTime(n.darkStart)}–${fmtTime(n.darkEnd)}` : 'Not fully dark tonight';
}
