import './styles.css';
import * as A from 'astronomy-engine';
import { loadCatalog, type Catalog, type Target } from './astro/catalog';
import { Frame, compass, moonInfo, nightFor, observerFor, type HorPos, type Site } from './astro/engine';
import { buildPlan, passItems, statusFor, itemFor, EQUIPMENT, SKY_LIMITS, type Plan } from './astro/plan';
import { buildSats, loadSatData, lookAt, siteGeodetic, type Pass, type Sat, type SatData, type PassRequest } from './astro/satellites';
import { loadSettings, saveSettings, type Alert, type View } from './state';
import { loadClouds, cloudAt, type CloudForecast } from './weather';
import { SkyView, type SatOnSky, type SatTrack } from './ui/skyview';
import { DeviceCompass } from './ui/compass';
import { renderDetail, renderTonight, subLine, type Category } from './ui/panels';
import { downloadIcs, ensurePermission, notificationState, scheduleAlerts } from './ui/alerts';
import { esc, fmtDay, fmtLatLon, fmtMag, fmtTime } from './ui/format';

// ------------------------------------------------------------------ state
const S = loadSettings();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $('app');
const panelTonight = $('panel-tonight');
const panelDetail = $('panel-detail');
const skyCard = $('sky-card');
const dialog = $<HTMLDialogElement>('settings');
const form = $<HTMLFormElement>('settings-form');

const state = {
  catalog: null as Catalog | null,
  plan: null as Plan | null,
  planKey: '',
  sats: [] as Sat[],
  satData: null as SatData | null,
  satStatus: 'Loading satellite data…',
  passes: [] as Pass[],
  passKey: '',
  clouds: null as CloudForecast | null,
  selectedId: null as string | null,
  view: 'sky' as View,
  detailOpen: false,
  offsetMin: 0,
  category: 'all' as Category,
};

const mqPhone = window.matchMedia('(max-width: 759px)');
const mqDesktop = window.matchMedia('(min-width: 1200px)');
function layout(): 'phone' | 'tablet' | 'desktop' {
  return mqPhone.matches ? 'phone' : mqDesktop.matches ? 'desktop' : 'tablet';
}

const now = () => Date.now() + state.offsetMin * 60e3;

const sky = new SkyView($<HTMLCanvasElement>('sky'), (id) => {
  state.selectedId = id;
  if (id && layout() !== 'phone') state.detailOpen = true;
  renderAll();
});

let passWorker: Worker | null = null;

// The chart puts the direction you face at the bottom, like holding up a planisphere.
const compassDev = new DeviceCompass((heading) => {
  sky.setRotation(rotForFacing(heading));
  renderChromeLight();
});
sky.onManualRotate = () => {
  if (compassDev.active) {
    compassDev.stop();
    toast('Compass off. You turned the chart by hand.');
    renderChromeLight();
  }
};

// Map style: the direction you face goes at the top (hold the tablet flat, top edge pointing that way).
// Overhead style: it goes at the bottom, like holding up a planisphere.
function facingNow(): number {
  return S.chartStyle === 'map' ? sky.rotation : (sky.rotation + 180) % 360;
}
function rotForFacing(f: number): number {
  return S.chartStyle === 'map' ? f : f + 180;
}

/** Cheap updates that follow the chart's rotation. */
function renderChromeLight() {
  $('turn-needle').style.transform = `rotate(${sky.northAngle}deg)`;
  const facing = compass(facingNow());
  $('turn-btn').setAttribute('aria-label', `Turn the chart. Now facing ${facing}, ${S.chartStyle === 'map' ? 'at the top' : 'at the bottom'}.`);
  const cb = $('compass-btn');
  cb.setAttribute('aria-pressed', String(compassDev.active));
}

async function toggleCompass() {
  if (compassDev.active) {
    compassDev.stop();
    renderChromeLight();
    renderSky();
    return;
  }
  if (!S.site) return;
  toast(S.chartStyle === 'map'
    ? 'Hold the tablet flat with its top edge pointing the way you face. That direction goes to the top of the chart.'
    : 'Hold the tablet the way you’re facing. The horizon you face goes to the bottom of the chart.');
  const res = await compassDev.start(S.site.lat, S.site.lon);
  if (res === 'insecure') toast('The compass needs the app to be opened over https://.');
  else if (res === 'denied') toast('Compass access was declined. You can turn the chart with two fingers instead.');
  else if (res === 'no-sensor') toast('No compass readings from this device. Turn the chart with two fingers or the turn button.');
  renderChromeLight();
  renderSky();
}

// ------------------------------------------------------------- targets
function satTarget(norad: number): Target | null {
  const sat = state.sats.find((s) => s.norad === norad);
  if (!sat) return null;
  return { id: `sat${norad}`, kind: 'sat', name: sat.name, label: sat.name, type: 'Satellite', cat: `NORAD ${norad}`, mag: null, size: null, norad };
}

function targetById(id: string | null): Target | null {
  if (!id || !state.catalog) return null;
  if (id.startsWith('sat')) return satTarget(Number(id.slice(3)));
  return state.catalog.targets.get(id) ?? null;
}

function liveFor(t: Target, frame: Frame): { alt: number; az: number; mag?: number; sunlit?: boolean } | null {
  if (t.kind === 'sat') {
    const sat = state.sats.find((s) => s.norad === t.norad);
    if (!sat || !S.site) return null;
    const lk = lookAt(sat, frame.date, siteGeodetic(S.site));
    return lk ? { alt: lk.alt, az: lk.az, mag: lk.sunlit && lk.alt > 0 ? lk.mag : undefined, sunlit: lk.sunlit } : null;
  }
  if (t.body !== undefined) {
    const p = frame.body(t.body);
    let mag: number | undefined;
    try {
      mag = A.Illumination(t.body, frame.time).mag;
    } catch {
      mag = undefined;
    }
    return { ...p, mag };
  }
  return { ...frame.radec(t.ra!, t.dec!), mag: t.mag ?? undefined };
}

// ------------------------------------------------------------- planning
function ensurePlan() {
  if (!S.site || !state.catalog) return;
  const night = nightFor(new Date(now()), S.site);
  if (!night) {
    state.plan = null;
    return;
  }
  const key = [night.sunset.getTime(), S.site.lat, S.site.lon, S.equipment, S.skyLimit, S.minAlt].join('|');
  if (key === state.planKey) return;
  state.planKey = key;
  state.plan = buildPlan(state.catalog, night, S.site, S.equipment, S.skyLimit, S.minAlt);
  // Passes don't depend on equipment, so reuse them when only that changed.
  const pk = [night.sunset.getTime(), S.site.lat, S.site.lon, state.satData?.fetchedAt].join('|');
  if (pk === state.passKey) state.plan.passes = passItems(state.passes, state.plan.timeline);
  else computePasses();
}

function computePasses() {
  const plan = state.plan;
  if (!plan || !state.satData || !S.site) return;
  const key = [plan.night.sunset.getTime(), S.site.lat, S.site.lon, state.satData.fetchedAt].join('|');
  state.passKey = key;
  passWorker?.terminate();
  passWorker = new Worker(new URL('./astro/passes.worker.ts', import.meta.url), { type: 'module' });
  passWorker.onmessage = (ev: MessageEvent<Pass[]>) => {
    if (state.passKey !== key) return;
    state.passes = ev.data;
    if (state.plan) state.plan.passes = passItems(ev.data, state.plan.timeline);
    const n = ev.data.length;
    state.satStatus = n ? '' : 'No bright satellite passes tonight.';
    renderPanels();
    passWorker?.terminate();
    passWorker = null;
  };
  const req: PassRequest = {
    omm: state.satData.omm,
    site: S.site,
    start: plan.night.sunset.getTime(),
    end: plan.night.sunrise.getTime(),
    sunAlt: Array.from(plan.timeline.sunAlt),
    sunStepMs: plan.timeline.stepMs,
  };
  passWorker.postMessage(req);
}

async function refreshSats(force = false) {
  state.satStatus = 'Loading satellite data…';
  const d = await loadSatData(S.satUrls, force);
  if (!d) {
    state.satStatus = 'Couldn’t load satellite data. Check the source in Settings.';
    state.sats = [];
  } else {
    state.satData = d;
    state.sats = buildSats(d.omm);
    state.satStatus = '';
    computePasses();
  }
  updateSatStatusText();
  renderPanels();
}

function updateSatStatusText() {
  const el = $('sat-status');
  if (!el) return;
  if (!state.satData) el.textContent = state.satStatus || 'No satellite data yet.';
  else {
    const age = Date.now() - state.satData.fetchedAt;
    el.textContent = `${state.sats.length} satellites · downloaded ${fmtDay(state.satData.fetchedAt)} ${fmtTime(state.satData.fetchedAt)}${age > 24 * 3600e3 ? ' (old: positions drift after a day or two)' : ''}`;
  }
}

async function refreshClouds() {
  if (!S.site) return;
  state.clouds = await loadClouds(S.site);
  renderPanels();
}

// ----------------------------------------------------------- rendering
interface SkySats {
  list: SatOnSky[];
  visible: number;
  others: number;
  dark: boolean;
}

/** Satellites above the horizon: visible ones in full, the rest (in shadow, faint or in daylight) as dim markers. */
function satsOnSky(frame: Frame): SkySats {
  const sunAlt = frame.sunAlt();
  const dark = sunAlt < -4;
  if (!S.showSats || !S.site || !state.sats.length) return { list: [], visible: 0, others: 0, dark };
  const gd = siteGeodetic(S.site);
  const lit: SatOnSky[] = [];
  const dim: SatOnSky[] = [];
  for (const sat of state.sats) {
    const id = `sat${sat.norad}`;
    const lk = lookAt(sat, frame.date, gd);
    if (!lk || lk.alt < 0) continue;
    const visible = lk.sunlit && dark && lk.mag <= 4.5;
    if (visible || id === state.selectedId) lit.push({ id, name: sat.name, look: { ...lk, sunlit: visible || lk.sunlit }, trail: [] });
    else dim.push({ id, name: sat.name, look: { ...lk, sunlit: false }, trail: [] });
  }
  lit.sort((a, b) => a.look.mag - b.look.mag);
  const shown = lit.slice(0, 30);
  for (const s of shown) {
    const sat = state.sats.find((x) => `sat${x.norad}` === s.id)!;
    const trail: HorPos[] = [];
    for (let dt = -180; dt <= 180; dt += 15) {
      const lk = lookAt(sat, new Date(frame.date.getTime() + dt * 1000), gd);
      if (lk) trail.push({ alt: lk.alt, az: lk.az });
    }
    s.trail = trail;
  }
  const visibleCount = lit.filter((s) => s.look.sunlit && dark && s.look.mag <= 4.5).length;
  return { list: [...dim, ...shown], visible: visibleCount, others: dim.length + lit.length - visibleCount, dark };
}

/** The selected satellite's next visible pass, as a path across the chart. */
let trackCache: { key: string; track: SatTrack } | null = null;
function trackFor(id: string | null, nowMs: number): SatTrack | null {
  if (!id || !id.startsWith('sat') || !S.site) return null;
  const norad = Number(id.slice(3));
  const pass = state.passes.find((p) => p.norad === norad && p.visEnd!.ms > nowMs);
  const sat = state.sats.find((s) => s.norad === norad);
  if (!pass || !sat) return null;
  const key = `${norad}|${pass.rise.ms}|${S.site.lat},${S.site.lon}`;
  if (trackCache?.key === key) return trackCache.track;
  const gd = siteGeodetic(S.site);
  const points: SatTrack['points'] = [];
  for (let ms = pass.rise.ms - 150e3; ms <= pass.set.ms + 150e3; ms += 10e3) {
    const lk = lookAt(sat, new Date(ms), gd);
    if (lk) points.push({ alt: lk.alt, az: lk.az, lit: ms >= pass.visStart!.ms && ms <= pass.visEnd!.ms });
  }
  const track: SatTrack = {
    points,
    start: { alt: pass.visStart!.alt, az: pass.visStart!.az, text: fmtTime(pass.visStart!.ms) },
    end: { alt: pass.visEnd!.alt, az: pass.visEnd!.az, text: fmtTime(pass.visEnd!.ms) },
  };
  trackCache = { key, track };
  return track;
}

function renderSky() {
  if (!S.site || !state.catalog) return;
  const frame = new Frame(new Date(now()), observerFor(S.site));
  const eq = EQUIPMENT[S.equipment];
  const sats = satsOnSky(frame);
  sky.render({
    frame,
    catalog: state.catalog,
    sats: sats.list,
    track: S.showSats ? trackFor(state.selectedId, frame.date.getTime()) : null,
    selectedId: state.selectedId,
    opts: {
      showConstellations: S.showConstellations,
      showConstNames: S.showConstNames,
      showDsos: S.showDsos,
      showSats: S.showSats,
      showMilkyWay: S.showMilkyWay,
      skyLimit: S.skyLimit,
      dsoLimit: Math.max(eq.dsoLimit(S.skyLimit), 8.5),
      fov: eq.fov,
    },
  });
  // Status chips over the chart
  const sunAlt = frame.sunAlt();
  const dark = sunAlt < -18 ? 'Fully dark' : sunAlt < -12 ? 'Nautical twilight' : sunAlt < -6 ? 'Twilight' : sunAlt < -0.8 ? 'Civil twilight' : 'Daylight';
  const moon = frame.body(A.Body.Moon);
  const mi = moonInfo(frame.date);
  const clouds = cloudAt(state.clouds, frame.date.getTime());
  const chips = [dark, `Moon ${Math.round(mi.fraction * 100)}% · ${moon.alt > 0 ? `${Math.round(moon.alt)}° up` : 'down'}`];
  if (clouds !== null) chips.push(`Clouds ${clouds}%`);
  if (S.showSats && state.sats.length) {
    chips.push(sats.dark
      ? `Satellites: ${sats.visible} visible · ${sats.others} dim or in Earth’s shadow`
      : `Satellites: ${sats.visible + sats.others} up · hidden by daylight`);
  } else if (S.showSats && state.satStatus) chips.push(state.satStatus);
  const rot = sky.rotation;
  if (compassDev.active || Math.abs(rot) > 0.5) chips.push(`Facing ${compass(facingNow())}${compassDev.active ? ' · compass' : ''}`);
  $('turn-needle').style.transform = `rotate(${sky.northAngle}deg)`;
  if (state.offsetMin !== 0) chips.push('Preview time');
  $('sky-chips').innerHTML = chips.map((c) => `<span>${esc(c)}</span>`).join('');
  const sel = targetById(state.selectedId);
  $('sky').setAttribute('aria-label', `All-sky chart for ${fmtTime(frame.date)}, north at top. ${sky.labelCount} objects labelled.${sel ? ` Selected: ${sel.name}.` : ''} The Tonight list has the same objects as text.`);
  renderSkyCard(frame);
}

function renderSkyCard(frame: Frame) {
  const t = targetById(state.selectedId);
  if (!t || layout() !== 'phone' || !state.plan) {
    skyCard.hidden = true;
    return;
  }
  const live = liveFor(t, frame);
  const it = t.kind === 'sat' ? state.plan.passes.find((p) => p.target.id === t.id) : itemFor(t, state.plan);
  const st = it ? statusFor(it, state.plan, now()) : null;
  skyCard.hidden = false;
  skyCard.innerHTML = `<div>
      <h2>${esc(t.name)}</h2>
      <p class="muted">${esc(subLine(t))}</p>
    </div>
    <div class="stats">
      <div class="stat"><span class="stat-k">Altitude</span><span class="stat-v">${live ? Math.round(live.alt) + '°' : '—'}</span></div>
      <div class="stat"><span class="stat-k">Direction</span><span class="stat-v">${live ? `${Math.round(live.az)}° ${compass(live.az)}` : '—'}</span></div>
      <div class="stat"><span class="stat-k">Mag</span><span class="stat-v">${fmtMag(live?.mag ?? t.mag)}</span></div>
    </div>
    ${st ? `<p class="item-status">${esc(st.line)}</p>` : ''}
    <div class="btn-row">
      <button type="button" class="btn btn-primary" data-action="open-detail">Details</button>
      <button type="button" class="btn" data-action="deselect">Clear</button>
    </div>`;
}

function renderPanels() {
  ensurePlan();
  const t = now();
  panelTonight.innerHTML = renderTonight({
    plan: state.plan, now: t, equipment: S.equipment, category: state.category, alerts: S.alerts,
    clouds: state.clouds, satStatus: state.satStatus, selectedId: state.selectedId, needsLocation: !S.site,
  });
  const target = targetById(state.selectedId);
  const frame = S.site ? new Frame(new Date(t), observerFor(S.site)) : null;
  panelDetail.innerHTML = renderDetail({
    target, plan: state.plan, now: t, live: target && frame ? liveFor(target, frame) : null,
    passes: state.passes, alerts: S.alerts, leadMin: S.leadMin, notify: notificationState(),
    equipment: S.equipment, layout: layout(),
  });
}

function renderChrome() {
  app.dataset.view = state.view;
  app.dataset.detail = state.detailOpen && state.selectedId ? 'open' : 'closed';
  for (const tab of document.querySelectorAll<HTMLElement>('.tab')) {
    tab.setAttribute('aria-current', tab.dataset.id === state.view ? 'page' : 'false');
  }
  const tl = $('time-label');
  const t = new Date(now());
  tl.textContent = state.offsetMin === 0 ? `Now · ${fmtTime(t)}` : `${fmtDay(t).split(',')[0]} ${fmtTime(t)}`;
  tl.classList.toggle('offset', state.offsetMin !== 0);
  tl.setAttribute('aria-label', state.offsetMin === 0 ? `Showing now, ${fmtTime(t)}` : `Previewing ${fmtDay(t)} ${fmtTime(t)}. Tap to return to now.`);
  $('loc-label').textContent = S.site ? S.site.name || fmtLatLon(S.site.lat, S.site.lon) : 'Set location';
  document.documentElement.classList.toggle('night', S.nightRed);
  $('night-btn').setAttribute('aria-pressed', String(S.nightRed));
}

function renderAll() {
  renderChrome();
  renderPanels();
  renderSky();
}

// --------------------------------------------------------------- alerts
let toastTimer = 0;
function toast(msg: string) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 6000);
}

function rearmAlerts() {
  scheduleAlerts(S.alerts, toast, () => renderPanels());
}

async function toggleAlert(targetId: string, eventAt: number, what: string) {
  const t = targetById(targetId);
  if (!t) return;
  const existing = S.alerts.find((a) => a.targetId === targetId && a.at > Date.now() - 60e3);
  if (existing) {
    S.alerts = S.alerts.filter((a) => a !== existing);
    saveSettings(S);
    rearmAlerts();
    toast(`Alert for ${t.name} removed.`);
    renderPanels();
    return;
  }
  const granted = await ensurePermission();
  const at = Math.max(Date.now() + 5e3, eventAt - S.leadMin * 60e3);
  const alert: Alert = { id: `${targetId}-${eventAt}`, targetId, name: t.name, at, what };
  S.alerts = [...S.alerts.filter((a) => a.at > Date.now() - 3600e3), alert];
  saveSettings(S);
  rearmAlerts();
  toast(granted
    ? `Alert set for ${fmtTime(at)}: ${t.name} ${what}. Keep Sky Planner open, or add it to your calendar too.`
    : `Alert set for ${fmtTime(at)}, shown in the app only. Notifications are off for this site; a calendar event is more reliable.`);
  renderPanels();
}

// ------------------------------------------------------------ settings
function fillSettings() {
  const f = form.elements as unknown as Record<string, HTMLInputElement>;
  f.lat.value = S.site ? String(S.site.lat) : '';
  f.lon.value = S.site ? String(S.site.lon) : '';
  f.elev.value = S.site ? String(S.site.elev) : '0';
  f.name.value = S.site?.name ?? '';
  (f.skyLimit as unknown as HTMLSelectElement).value = String(S.skyLimit);
  (f.minAlt as unknown as HTMLSelectElement).value = String(S.minAlt);
  for (const k of ['showConstellations', 'showConstNames', 'showMilkyWay', 'showDsos', 'showSats'] as const) f[k].checked = S[k];
  for (const r of form.querySelectorAll<HTMLInputElement>('input[name="chartStyle"]')) r.checked = r.value === S.chartStyle;
  (f.satUrls as unknown as HTMLTextAreaElement).value = S.satUrls.join('\n');
  $('settings-intro').hidden = !!S.site;
  $('geo-status').textContent = '';
  updateSatStatusText();
}

function openSettings() {
  fillSettings();
  dialog.showModal();
}

function applySettings() {
  const fd = new FormData(form);
  const lat = Number(fd.get('lat'));
  const lon = Number(fd.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  const prevSite = S.site;
  const site: Site = { lat, lon, elev: Number(fd.get('elev')) || 0, name: String(fd.get('name') || '').trim() || undefined };
  S.site = site;
  S.skyLimit = Number(fd.get('skyLimit'));
  S.minAlt = Number(fd.get('minAlt'));
  S.showConstellations = fd.get('showConstellations') === 'on';
  S.showConstNames = fd.get('showConstNames') === 'on';
  S.showMilkyWay = fd.get('showMilkyWay') === 'on';
  const style = fd.get('chartStyle') === 'overhead' ? 'overhead' : 'map';
  if (style !== S.chartStyle) {
    S.chartStyle = style;
    sky.setMapStyle(style === 'map');
    if (!compassDev.active) sky.setRotation(0);
    renderChromeLight();
  }
  S.showDsos = fd.get('showDsos') === 'on';
  S.showSats = fd.get('showSats') === 'on';
  const urls = String(fd.get('satUrls') || '').split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u));
  const urlsChanged = urls.join() !== S.satUrls.join();
  if (urls.length) S.satUrls = urls;
  saveSettings(S);
  const moved = !prevSite || prevSite.lat !== site.lat || prevSite.lon !== site.lon;
  if (moved) {
    state.passKey = '';
    refreshClouds();
  }
  renderAll();
  if (moved || urlsChanged) refreshSats(urlsChanged);
}

dialog.addEventListener('close', () => {
  if (dialog.returnValue === 'save') applySettings();
  dialog.returnValue = '';
});

function geolocate() {
  const status = $('geo-status');
  if (!('geolocation' in navigator)) {
    status.textContent = 'This browser can’t share its location. Enter it below.';
    return;
  }
  status.textContent = 'Finding you…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const f = form.elements as unknown as Record<string, HTMLInputElement>;
      f.lat.value = pos.coords.latitude.toFixed(4);
      f.lon.value = pos.coords.longitude.toFixed(4);
      if (pos.coords.altitude !== null) f.elev.value = String(Math.round(pos.coords.altitude));
      status.textContent = `Found you, to within about ${Math.round(pos.coords.accuracy)} m. Press Save to use it.`;
    },
    (err) => {
      status.textContent = err.code === err.PERMISSION_DENIED
        ? 'Location permission was declined. Enter latitude and longitude instead.'
        : 'Couldn’t get a location fix. Enter latitude and longitude instead.';
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 },
  );
}

// ---------------------------------------------------------------- events
function select(id: string, open: boolean) {
  state.selectedId = id;
  state.detailOpen = open;
  renderAll();
}

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  const id = el.dataset.id ?? '';
  switch (el.dataset.action) {
    case 'open-settings': openSettings(); break;
    case 'geolocate': geolocate(); break;
    case 'refresh-sats': refreshSats(true); break;
    case 'time-step':
      state.offsetMin = Math.max(-24 * 60, Math.min(48 * 60, state.offsetMin + Number(el.dataset.step)));
      renderAll();
      break;
    case 'time-live': state.offsetMin = 0; renderAll(); break;
    case 'night': S.nightRed = !S.nightRed; saveSettings(S); renderChrome(); break;
    case 'zoom-in': sky.zoomBy(1.6); break;
    case 'zoom-out': sky.zoomBy(1 / 1.6); break;
    case 'zoom-reset': sky.reset(); break;
    case 'turn': {
      if (compassDev.active) compassDev.stop();
      // Step the horizon at the bottom of the chart: S -> W -> N -> E.
      // Map style steps the top through N, E, S, W; overhead style steps the bottom through S, W, N, E.
      const facing = facingNow();
      const step = S.chartStyle === 'map' ? 1 : -1;
      const next = (((Math.round(facing / 90) + step) % 4) + 4) % 4 * 90;
      sky.setRotation(rotForFacing(next));
      renderChromeLight();
      renderSky();
      break;
    }
    case 'compass': toggleCompass(); break;
    case 'view': state.view = id as View; state.detailOpen = false; renderAll(); break;
    case 'select': select(id, true); break;
    case 'open-detail': state.detailOpen = true; renderChrome(); break;
    case 'close-detail': state.detailOpen = false; renderChrome(); break;
    case 'deselect': state.selectedId = null; state.detailOpen = false; renderAll(); break;
    case 'equip': S.equipment = id as typeof S.equipment; saveSettings(S); renderAll(); break;
    case 'category': state.category = id as Category; renderPanels(); break;
    case 'quick-alert': {
      const t = targetById(id);
      if (!t || !state.plan) break;
      const existing = S.alerts.find((a) => a.targetId === id && a.at > Date.now() - 60e3);
      if (existing) { toggleAlert(id, existing.at, existing.what); break; }
      const it = t.kind === 'sat' ? state.plan.passes.find((p) => p.target.id === id) : itemFor(t, state.plan);
      const st = it ? statusFor(it, state.plan, now()) : null;
      if (st?.alertAt && st.alertWhat) toggleAlert(id, st.alertAt, st.alertWhat);
      break;
    }
    case 'toggle-alert': toggleAlert(id, Number(el.dataset.at), el.dataset.what ?? ''); break;
    case 'remove-alert':
      S.alerts = S.alerts.filter((a) => a.id !== id);
      saveSettings(S);
      rearmAlerts();
      renderPanels();
      break;
    case 'ics': {
      const t = targetById(id);
      if (!t) break;
      const at = Number(el.dataset.at);
      const what = el.dataset.what ?? '';
      const where = S.site ? (S.site.name || fmtLatLon(S.site.lat, S.site.lon)) : '';
      downloadIcs(`${t.name} ${what}`, `${t.name} (${subLine(t)}) ${what}. From ${where}. Planned with Sky Planner.`, at, S.leadMin);
      break;
    }
    case 'find': {
      const t = targetById(id);
      if (!t || !S.site) break;
      const live = liveFor(t, new Frame(new Date(now()), observerFor(S.site)));
      if (!live) break;
      state.selectedId = id;
      if (live.alt < -2) {
        // A satellite that isn't up yet: show its whole pass track.
        if (layout() === 'phone') {
          state.view = 'sky';
          state.detailOpen = false;
        }
        renderAll();
        sky.reset();
        break;
      }
      if (layout() === 'phone') {
        state.view = 'sky';
        state.detailOpen = false;
      }
      renderAll();
      sky.centerOn(live.alt, live.az, t.kind === 'dso' && S.equipment === 'seestar' ? 4 : 2.5);
      break;
    }
  }
});

document.addEventListener('change', (e) => {
  const el = e.target as HTMLSelectElement;
  if (el.dataset.action === 'lead') {
    S.leadMin = Number(el.value);
    saveSettings(S);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.detailOpen && layout() !== 'desktop' && !dialog.open) {
    state.detailOpen = false;
    renderChrome();
  }
});

for (const mq of [mqPhone, mqDesktop]) mq.addEventListener('change', () => renderAll());

// ------------------------------------------------------------------ boot
async function boot() {
  $('compass-btn').hidden = !DeviceCompass.likelyAvailable();
  sky.setMapStyle(S.chartStyle === 'map');
  const skyLimit = $<HTMLSelectElement>('sky-limit');
  skyLimit.innerHTML = SKY_LIMITS.map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join('');
  renderChrome();
  panelTonight.innerHTML = renderTonight({ plan: null, now: now(), equipment: S.equipment, category: state.category, alerts: S.alerts, clouds: null, satStatus: '', selectedId: null, needsLocation: !S.site });
  try {
    state.catalog = await loadCatalog();
  } catch (e) {
    panelTonight.innerHTML = `<div class="empty"><p>Couldn’t load the star catalogue: ${esc((e as Error).message)}</p></div>`;
    return;
  }
  renderAll();
  rearmAlerts();
  if (!S.site) openSettings();
  else refreshClouds();
  refreshSats();

  // Sky every second (satellites move); lists every 30 seconds.
  let lastPanels = Date.now();
  setInterval(() => {
    if (document.hidden) return;
    renderChrome();
    renderSky();
    if (Date.now() - lastPanels > 30e3) {
      lastPanels = Date.now();
      renderPanels();
    }
  }, 1000);
  // Refresh weather hourly and satellite data when it gets old.
  setInterval(() => {
    refreshClouds();
    refreshSats();
  }, 3600e3);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) renderAll();
  });
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}

boot();
