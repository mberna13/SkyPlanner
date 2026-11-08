// All-sky canvas: zenith-centred stereographic projection, north up, east left (as when looking up).
import type { Catalog, Target } from '../astro/catalog';
import { starColor } from '../astro/catalog';
import { DEG, Frame, galacticPlane, PLANETS, moonInfo, type HorPos } from '../astro/engine';
import * as A from 'astronomy-engine';
import type { SatLook } from '../astro/satellites';

export interface SatOnSky {
  id: string;
  name: string;
  look: SatLook;
  trail: HorPos[];
}

export interface SceneOptions {
  showConstellations: boolean;
  showConstNames: boolean;
  showDsos: boolean;
  showSats: boolean;
  showMilkyWay: boolean;
  skyLimit: number; // naked-eye limiting magnitude for the site
  dsoLimit: number; // faintest DSO to draw for the chosen equipment
  fov: [number, number] | null; // equipment field of view (arcmin) drawn around the selection
}

/** Path of the selected satellite's next pass, drawn across the chart. */
export interface SatTrack {
  points: (HorPos & { lit: boolean })[];
  start: HorPos & { text: string };
  end: HorPos & { text: string };
}

export interface Scene {
  frame: Frame;
  catalog: Catalog;
  sats: SatOnSky[];
  track: SatTrack | null;
  selectedId: string | null;
  opts: SceneOptions;
}

interface Hit {
  id: string;
  x: number;
  y: number;
  r: number;
  pri: number;
}

interface LabelReq {
  text: string;
  x: number;
  y: number;
  r: number;
  pri: number;
  color: string;
  style: 'object' | 'constellation' | 'selected';
}

const MW = galacticPlane(2);
const PALETTE = {
  ground: '#07090F',
  horizon: '#3B4566',
  grid: 'rgba(120, 136, 180, 0.22)',
  constLine: 'rgba(110, 135, 200, 0.38)',
  constName: 'rgba(150, 165, 205, 0.75)',
  label: '#C9D1E0',
  labelDim: '#9AA4B8',
  dso: '#B49CFF',
  sat: '#7FB3FF',
  accent: '#F2B544',
  cardinal: '#E6EAF2',
};

export class SkyView {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private hits: Hit[] = [];
  private scene: Scene | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: {
    startX: number; startY: number; t: number; moved: boolean;
    pinchDist: number; pinchZoom: number; pinchAngle: number; startRot: number; rotating: boolean;
  } | null = null;
  /** Azimuth shown at the top of the chart (0 = north up). */
  private rot = 0;
  /** true: east on the right, like a map. false: east on the left, as when looking up. */
  private mapStyle = true;
  /** Called when the user turns the chart by hand. */
  onManualRotate: (() => void) | null = null;
  labelCount = 0;

  constructor(private canvas: HTMLCanvasElement, private onSelect: (id: string | null) => void) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.bindInput();
  }

  // ------------------------------------------------------------ geometry
  private get radius() {
    return Math.max(40, Math.min(this.w, this.h) / 2 - 26);
  }
  private get cx() {
    return this.w / 2 + this.panX;
  }
  private get cy() {
    return this.h / 2 + this.panY;
  }

  /** Screen position, or null if too far below the horizon. */
  project(alt: number, az: number, limitBelow = 3): { x: number; y: number } | null {
    if (alt < -limitBelow) return null;
    return this.projectRaw(alt, az);
  }

  private projectRaw(alt: number, az: number) {
    const z = (90 - alt) * DEG;
    const rr = this.radius * this.zoom * Math.tan(z / 2);
    const a = (az - this.rot) * DEG;
    // Map style puts east on the right (like a map); overhead style puts it on the left (as when looking up).
    const sx = this.mapStyle ? 1 : -1;
    return { x: this.cx + sx * rr * Math.sin(a), y: this.cy - rr * Math.cos(a) };
  }

  /** Pixels per degree of sky at a given altitude. */
  private pxPerDeg(alt: number) {
    const z = (90 - alt) * DEG;
    const c = Math.cos(z / 2);
    return (this.radius * this.zoom * DEG) / (2 * c * c);
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.clampPan();
    if (this.scene) this.render(this.scene);
  }

  // ------------------------------------------------------------- controls
  zoomBy(f: number, ax = this.w / 2, ay = this.h / 2) {
    const z0 = this.zoom;
    const z1 = Math.max(1, Math.min(10, z0 * f));
    const k = z1 / z0;
    // keep the point under (ax, ay) fixed
    this.panX = ax - this.w / 2 - (ax - this.cx) * k;
    this.panY = ay - this.h / 2 - (ay - this.cy) * k;
    this.zoom = z1;
    this.clampPan();
    this.redraw();
  }

  reset() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.redraw();
  }

  centerOn(alt: number, az: number, minZoom = 2.5) {
    this.zoom = Math.max(this.zoom, minZoom);
    this.panX = 0;
    this.panY = 0;
    const p = this.projectRaw(alt, az);
    this.panX = this.w / 2 - p.x;
    this.panY = this.h / 2 - p.y;
    this.clampPan();
    this.redraw();
  }

  get zoomLevel() {
    return this.zoom;
  }

  get rotation() {
    return this.rot;
  }

  setMapStyle(on: boolean) {
    if (on === this.mapStyle) return;
    this.mapStyle = on;
    this.redraw();
  }

  /** Where north is on screen, in degrees clockwise from straight up. */
  get northAngle() {
    return this.mapStyle ? -this.rot : this.rot;
  }

  /** Put azimuth `deg` at the top of the chart. */
  setRotation(deg: number) {
    const r = ((deg % 360) + 360) % 360;
    if (Math.abs(r - this.rot) < 0.05) return;
    this.rot = r;
    this.redraw();
  }

  private clampPan() {
    const lim = this.radius * this.zoom;
    this.panX = Math.max(-lim, Math.min(lim, this.panX));
    this.panY = Math.max(-lim, Math.min(lim, this.panY));
    if (this.zoom <= 1.001) {
      this.panX = 0;
      this.panY = 0;
    }
  }

  private redraw() {
    if (this.scene) this.render(this.scene);
  }

  private bindInput() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pointers.size === 1) {
        this.gesture = { startX: e.offsetX, startY: e.offsetY, t: performance.now(), moved: false, pinchDist: 0, pinchZoom: this.zoom, pinchAngle: 0, startRot: this.rot, rotating: false };
      } else if (this.pointers.size === 2 && this.gesture) {
        const [a, b] = [...this.pointers.values()];
        this.gesture.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        this.gesture.pinchZoom = this.zoom;
        this.gesture.pinchAngle = Math.atan2(b.y - a.y, b.x - a.x) / DEG;
        this.gesture.startRot = this.rot;
        this.gesture.rotating = false;
        this.gesture.moved = true;
      }
    });
    c.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev || !this.gesture) return;
      const cur = { x: e.offsetX, y: e.offsetY };
      this.pointers.set(e.pointerId, cur);
      if (this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.gesture.pinchDist > 0) {
          const target = this.gesture.pinchZoom * (d / this.gesture.pinchDist);
          this.zoomBy(target / this.zoom, (a.x + b.x) / 2, (a.y + b.y) / 2);
          // Two-finger twist turns the chart (after a small dead zone so pinches don't wobble it).
          let delta = Math.atan2(b.y - a.y, b.x - a.x) / DEG - this.gesture.pinchAngle;
          delta = ((delta + 540) % 360) - 180;
          if (!this.gesture.rotating && Math.abs(delta) > 8) {
            this.gesture.rotating = true;
            this.onManualRotate?.();
          }
          if (this.gesture.rotating) this.setRotation(this.gesture.startRot + (this.mapStyle ? -delta : delta));
        }
        return;
      }
      if (!this.gesture.moved && Math.hypot(cur.x - this.gesture.startX, cur.y - this.gesture.startY) > 6) this.gesture.moved = true;
      if (this.gesture.moved && this.zoom > 1.001) {
        this.panX += cur.x - prev.x;
        this.panY += cur.y - prev.y;
        this.clampPan();
        this.redraw();
      }
    });
    const end = (e: PointerEvent) => {
      const g = this.gesture;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size > 0) return;
      this.gesture = null;
      if (g && !g.moved && performance.now() - g.t < 600) this.tap(e.offsetX, e.offsetY);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) this.gesture = null;
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey) {
        // Shift + scroll turns the chart on a desktop.
        this.onManualRotate?.();
        this.setRotation(this.rot + (e.deltaY || e.deltaX) * 0.15);
        return;
      }
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY);
    }, { passive: false });
    c.addEventListener('dblclick', (e) => this.zoomBy(2, e.offsetX, e.offsetY));
  }

  private tap(x: number, y: number) {
    let best: Hit | null = null;
    let bestScore = Infinity;
    for (const h of this.hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      const reach = Math.max(18, h.r + 10);
      if (d > reach) continue;
      const s = d - h.pri * 0.004; // nudge toward more important objects
      if (s < bestScore) {
        bestScore = s;
        best = h;
      }
    }
    this.onSelect(best ? best.id : null);
  }

  // ------------------------------------------------------------- drawing
  render(scene: Scene) {
    this.scene = scene;
    const ctx = this.ctx;
    const { frame, catalog, opts } = scene;
    const R = this.radius * this.zoom;
    const cx = this.cx;
    const cy = this.cy;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.hits = [];
    const labels: LabelReq[] = [];

    const sunEq = frame.bodyRaDec(A.Body.Sun);
    const sun = frame.radec(sunEq.ra, sunEq.dec);
    const sunAlt = sun.alt;

    // Background: ground, then the sky disc tinted by how dark it is.
    ctx.fillStyle = PALETTE.ground;
    ctx.fillRect(0, 0, this.w, this.h);
    const night = Math.max(0, Math.min(1, (-sunAlt - 2) / 16)); // 0 = day, 1 = astronomical night
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, mix('#3E6FB8', '#0C1224', night));
    g.addColorStop(1, mix('#79A3D9', '#141C36', night));
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.05, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    // Stars fade in as the sky darkens.
    const limit = this.drawLimit(sunAlt, opts.skyLimit);

    if (opts.showMilkyWay && night > 0.6) this.drawMilkyWay(frame, night);
    this.drawGrid(cx, cy, R);
    if (opts.showConstellations && night > 0.3) this.drawConstellations(frame, catalog, opts.showConstNames, labels);

    // Stars
    for (const s of catalog.stars) {
      if (s.mag > limit) break; // sorted brightest first
      const hp = frame.radec(s.ra, s.dec);
      if (hp.alt < -1) continue;
      const p = this.project(hp.alt, hp.az, 1);
      if (!p || p.x < -5 || p.y < -5 || p.x > this.w + 5 || p.y > this.h + 5) continue;
      const r = Math.max(0.55, Math.min(4.6, 0.7 + (limit - s.mag) * 0.52)) * (0.85 + 0.15 * Math.min(this.zoom, 3));
      const alpha = Math.max(0.35, Math.min(1, 0.45 + (limit - s.mag) * 0.3));
      ctx.globalAlpha = alpha * (hp.alt < 0 ? 0.4 : 1);
      ctx.fillStyle = starColor(s.bv);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (s.name && hp.alt > 0) {
        const id = `hip${s.hip}`;
        this.hits.push({ id, x: p.x, y: p.y, r, pri: 300 - s.mag * 40 });
        if (s.mag < limit - 1.2 || id === scene.selectedId) {
          labels.push({ text: s.name, x: p.x, y: p.y, r, pri: id === scene.selectedId ? 1000 : 450 - s.mag * 45, color: PALETTE.label, style: id === scene.selectedId ? 'selected' : 'object' });
        }
      }
    }

    // Deep-sky objects
    if (opts.showDsos && night > 0.5) {
      for (const t of catalog.targets.values()) {
        if (t.kind !== 'dso') continue;
        const d = t.dso!;
        const isSel = t.id === scene.selectedId;
        const m = t.mag ?? 12;
        // Whole-sky view: Messier and named objects. Zooming in reveals fainter catalogue objects.
        // Small screens get fewer until you zoom in.
        const famous = d.m !== null || !!d.name;
        const crowd = this.radius < 260 ? 2.5 : 0;
        const zoomGain = 1.6 * Math.log2(this.zoom);
        const show = isSel || (m <= opts.dsoLimit && (famous
          ? m <= opts.dsoLimit - 1 - crowd + zoomGain
          : m <= opts.dsoLimit - 4 - crowd + zoomGain));
        if (!show) continue;
        const hp = frame.radec(t.ra!, t.dec!);
        if (hp.alt < 0) continue;
        const p = this.project(hp.alt, hp.az);
        if (!p || p.x < -20 || p.y < -20 || p.x > this.w + 20 || p.y > this.h + 20) continue;
        const r = this.drawDso(t, p.x, p.y, hp.alt);
        const pri = isSel ? 1000 : (d.m ? 520 : 300) + (d.name ? 40 : 0) - m * 12;
        this.hits.push({ id: t.id, x: p.x, y: p.y, r, pri });
        labels.push({ text: t.label, x: p.x, y: p.y, r, pri, color: PALETTE.dso, style: isSel ? 'selected' : 'object' });
      }
    }

    // Planets
    for (const pl of PLANETS) {
      const hp = frame.body(pl.body);
      if (hp.alt < -1) continue;
      const mag = Math.max(-5, Math.min(8, magCache(pl.body, frame.date)));
      if (mag > limit + 0.8 && pl.body !== A.Body.Venus) continue;
      const p = this.project(hp.alt, hp.az, 1);
      if (!p) continue;
      const id = pl.name.toLowerCase();
      const r = Math.max(2.5, Math.min(6.5, 4.5 - mag * 0.8));
      ctx.fillStyle = pl.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
      const isSel = id === scene.selectedId;
      this.hits.push({ id, x: p.x, y: p.y, r, pri: 800 - mag });
      labels.push({ text: pl.name, x: p.x, y: p.y, r, pri: isSel ? 1000 : 800 - mag, color: pl.color, style: isSel ? 'selected' : 'object' });
    }

    // Moon (with phase) and Sun
    const moonEq = frame.bodyRaDec(A.Body.Moon);
    const moon = frame.radec(moonEq.ra, moonEq.dec);
    if (moon.alt > -1) {
      const p = this.project(moon.alt, moon.az, 1);
      if (p) {
        const r = Math.max(7, Math.min(60, this.pxPerDeg(moon.alt) * 0.26));
        const sp = this.projectRaw(Math.max(sun.alt, -80), sun.az);
        this.drawMoon(p.x, p.y, r, Math.atan2(sp.y - p.y, sp.x - p.x), moonInfo(frame.date).fraction);
        const isSel = scene.selectedId === 'moon';
        this.hits.push({ id: 'moon', x: p.x, y: p.y, r, pri: 900 });
        labels.push({ text: 'Moon', x: p.x, y: p.y, r, pri: isSel ? 1000 : 900, color: '#EDEAE0', style: isSel ? 'selected' : 'object' });
      }
    }
    if (sun.alt > -1) {
      const p = this.project(sun.alt, sun.az, 1);
      if (p) {
        const r = Math.max(8, this.pxPerDeg(sun.alt) * 0.27);
        ctx.fillStyle = '#FFE08A';
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        labels.push({ text: 'Sun', x: p.x, y: p.y, r, pri: 890, color: '#FFE08A', style: 'object' });
      }
    }

    // Satellites
    if (opts.showSats && scene.track) this.drawTrack(scene.track, labels);
    if (opts.showSats) {
      for (const s of scene.sats) {
        const isSel = s.id === scene.selectedId;
        const p = this.project(s.look.alt, s.look.az, 0);
        if (!p) continue;
        if (!s.look.sunlit && !isSel) {
          // In Earth's shadow: up, but not visible. Small dim marker, no label.
          ctx.fillStyle = 'rgba(110, 125, 160, 0.55)';
          ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
          this.hits.push({ id: s.id, x: p.x, y: p.y, r: 3, pri: 100 });
          continue;
        }
        ctx.strokeStyle = 'rgba(127, 179, 255, 0.45)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        let started = false;
        for (const tp of s.trail) {
          const q = this.project(tp.alt, tp.az, 0);
          if (!q) {
            started = false;
            continue;
          }
          if (!started) ctx.moveTo(q.x, q.y);
          else ctx.lineTo(q.x, q.y);
          started = true;
        }
        ctx.stroke();
        ctx.setLineDash([]);
        const r = 4.5;
        ctx.fillStyle = s.look.sunlit ? PALETTE.sat : '#4A5878';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r, p.y);
        ctx.lineTo(p.x, p.y + r);
        ctx.lineTo(p.x - r, p.y);
        ctx.closePath();
        ctx.fill();
        const pri = isSel ? 1000 : 700 - s.look.mag * 10;
        this.hits.push({ id: s.id, x: p.x, y: p.y, r: r + 2, pri });
        labels.push({ text: s.name, x: p.x, y: p.y, r, pri, color: PALETTE.sat, style: isSel ? 'selected' : 'object' });
      }
    }

    ctx.restore();

    // Horizon and compass
    ctx.strokeStyle = PALETTE.horizon;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    this.drawCompass(cx, cy, R);

    // Selection marker and field-of-view box
    const sel = scene.selectedId ? this.hits.find((h) => h.id === scene.selectedId) : null;
    if (sel) {
      if (opts.fov) this.drawFov(sel.x, sel.y, opts.fov, scene, frame);
      ctx.strokeStyle = PALETTE.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sel.x, sel.y, sel.r + 7, 0, Math.PI * 2);
      ctx.stroke();
    }

    this.placeLabels(labels);
  }

  private drawTrack(track: SatTrack, labels: LabelReq[]) {
    const ctx = this.ctx;
    const seg = (lit: boolean) => {
      ctx.beginPath();
      let started = false;
      for (const p of track.points) {
        const q = p.lit === lit && p.alt >= 0 ? this.project(p.alt, p.az, 0) : null;
        if (!q) {
          started = false;
          continue;
        }
        if (!started) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
        started = true;
      }
      ctx.stroke();
    };
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = 'rgba(127, 179, 255, 0.45)';
    seg(false);
    ctx.setLineDash([]);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(127, 179, 255, 0.95)';
    seg(true);
    // Arrowhead at the end of the visible part
    const end = this.project(track.end.alt, track.end.az, 0);
    const pts = track.points.filter((p) => p.lit && p.alt >= 0);
    const before = pts.length > 2 ? this.project(pts[pts.length - 3].alt, pts[pts.length - 3].az, 0) : null;
    if (end && before) {
      const ang = Math.atan2(end.y - before.y, end.x - before.x);
      ctx.fillStyle = 'rgba(127, 179, 255, 0.95)';
      ctx.beginPath();
      ctx.moveTo(end.x + Math.cos(ang) * 8, end.y + Math.sin(ang) * 8);
      ctx.lineTo(end.x + Math.cos(ang + 2.5) * 7, end.y + Math.sin(ang + 2.5) * 7);
      ctx.lineTo(end.x + Math.cos(ang - 2.5) * 7, end.y + Math.sin(ang - 2.5) * 7);
      ctx.closePath();
      ctx.fill();
    }
    for (const [p, text] of [[track.start, track.start.text], [track.end, track.end.text]] as const) {
      const q = this.project(p.alt, p.az, 0);
      if (!q) continue;
      ctx.fillStyle = PALETTE.sat;
      ctx.beginPath();
      ctx.arc(q.x, q.y, 3, 0, Math.PI * 2);
      ctx.fill();
      labels.push({ text, x: q.x, y: q.y, r: 4, pri: 990, color: PALETTE.sat, style: 'object' });
    }
  }

  private drawLimit(sunAlt: number, skyLimit: number) {
    if (sunAlt >= 0) return -2;
    if (sunAlt >= -6) return lerp(-1.5, 2.2, -sunAlt / 6);
    if (sunAlt >= -12) return lerp(2.2, Math.min(4.2, skyLimit), (-sunAlt - 6) / 6);
    if (sunAlt >= -18) return lerp(Math.min(4.2, skyLimit), skyLimit, (-sunAlt - 12) / 6);
    return Math.min(6.2, skyLimit + 0.2 + Math.log2(this.zoom) * 0.6);
  }

  private drawMilkyWay(frame: Frame, night: number) {
    const ctx = this.ctx;
    const pts: ({ x: number; y: number } | null)[] = MW.map(([ra, dec]) => {
      const hp = frame.radec(ra, dec, false);
      return this.project(hp.alt, hp.az, 25);
    });
    const ppd = this.pxPerDeg(60);
    const passes = [
      { w: ppd * 22, a: 0.035 },
      { w: ppd * 14, a: 0.045 },
      { w: ppd * 7, a: 0.05 },
    ];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const ps of passes) {
      ctx.strokeStyle = `rgba(170, 182, 225, ${ps.a * night})`;
      ctx.lineWidth = ps.w;
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        if (!p) {
          started = false;
          continue;
        }
        if (!started) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
        started = true;
      }
      ctx.stroke();
    }
  }

  private drawGrid(cx: number, cy: number, R: number) {
    const ctx = this.ctx;
    ctx.strokeStyle = PALETTE.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    for (const alt of [30, 60]) {
      const rr = R * Math.tan(((90 - alt) * DEG) / 2);
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(150, 160, 190, 0.65)';
      ctx.font = '10px Inter, system-ui, sans-serif';
      ctx.fillText(`${alt}°`, cx + 4, cy - rr - 3);
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(120, 136, 180, 0.12)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(150,160,190,0.5)';
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy);
    ctx.lineTo(cx + 4, cy);
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx, cy + 4);
    ctx.stroke();
  }

  private drawConstellations(frame: Frame, catalog: Catalog, names: boolean, labels: LabelReq[]) {
    const ctx = this.ctx;
    ctx.strokeStyle = PALETTE.constLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const c of catalog.constellations) {
      for (const seg of c.lines) {
        let prev: { x: number; y: number } | null = null;
        for (const [ra, dec] of seg) {
          const hp = frame.radec(ra, dec, false);
          const p = hp.alt > -8 ? this.project(hp.alt, hp.az, 8) : null;
          if (p && prev) {
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(p.x, p.y);
          }
          prev = p;
        }
      }
      if (names && c.label) {
        const hp = frame.radec(c.label[0], c.label[1], false);
        if (hp.alt > 8) {
          const p = this.project(hp.alt, hp.az);
          if (p) labels.push({ text: c.name.toUpperCase(), x: p.x, y: p.y, r: 0, pri: 60 + (4 - c.rank) * 10, color: PALETTE.constName, style: 'constellation' });
        }
      }
    }
    ctx.stroke();
  }

  /** Draws a deep-sky symbol; returns its radius in px. */
  private drawDso(t: Target, x: number, y: number, alt: number): number {
    const ctx = this.ctx;
    const d = t.dso!;
    const ppd = this.pxPerDeg(alt);
    const maj = t.size ? (t.size[0] / 60) * ppd : 0;
    const min = t.size ? (t.size[1] / 60) * ppd : 0;
    const r = Math.max(4.5, Math.min(80, maj / 2));
    const rMin = Math.max(3, Math.min(80, min / 2));
    ctx.strokeStyle = PALETTE.dso;
    ctx.fillStyle = 'rgba(180, 156, 255, 0.12)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    switch (d.group) {
      case 'galaxy':
        ctx.ellipse(x, y, r, Math.max(2.5, Math.min(r, rMin)), -0.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        break;
      case 'cluster':
        ctx.setLineDash([2.5, 2.5]);
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      case 'globular':
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - r, y);
        ctx.lineTo(x + r, y);
        ctx.moveTo(x, y - r);
        ctx.lineTo(x, y + r);
        ctx.stroke();
        break;
      default: {
        const s = r * 0.9;
        roundRect(ctx, x - s, y - s, s * 2, s * 2, Math.min(4, s / 2));
        ctx.fill();
        ctx.stroke();
      }
    }
    return r;
  }

  private drawMoon(x: number, y: number, r: number, sunAngle: number, k: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(sunAngle);
    ctx.fillStyle = '#2B2D33';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    const lit = '#EDEAE0';
    ctx.fillStyle = lit;
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2); // half facing the Sun
    ctx.fill();
    const rx = r * Math.abs(2 * k - 1);
    ctx.fillStyle = k >= 0.5 ? lit : '#2B2D33';
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(0.01, rx), r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(237,234,224,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawCompass(cx: number, cy: number, R: number) {
    const ctx = this.ctx;
    const dirs: [string, number, boolean][] = [
      ['N', 0, true], ['NE', 45, false], ['E', 90, true], ['SE', 135, false],
      ['S', 180, true], ['SW', 225, false], ['W', 270, true], ['NW', 315, false],
    ];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [name, az, major] of dirs) {
      const a = (az - this.rot) * DEG;
      const sx = this.mapStyle ? 1 : -1;
      const out = R + 13;
      let x = cx + sx * out * Math.sin(a);
      let y = cy - out * Math.cos(a);
      // keep labels on screen when zoomed in
      x = Math.max(10, Math.min(this.w - 10, x));
      y = Math.max(10, Math.min(this.h - 10, y));
      ctx.font = `${major ? 600 : 500} ${major ? 12 : 10}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = major ? PALETTE.cardinal : PALETTE.labelDim;
      ctx.fillText(name, x, y);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  private drawFov(x: number, y: number, fov: [number, number], scene: Scene, frame: Frame) {
    // Box is drawn in local scale at the object's altitude.
    const t = scene.catalog.targets.get(scene.selectedId!);
    let alt = 45;
    if (t?.ra !== undefined) alt = frame.radec(t.ra, t.dec!).alt;
    else if (t?.body !== undefined) alt = frame.body(t.body).alt;
    const ppd = this.pxPerDeg(alt);
    const w = (fov[0] / 60) * ppd;
    const h = (fov[1] / 60) * ppd;
    if (w < 14 || w > this.w * 1.5) return;
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(242, 181, 68, 0.85)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    if (fov[0] === fov[1]) {
      ctx.beginPath();
      ctx.arc(x, y, w / 2, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    }
    ctx.setLineDash([]);
  }

  private placeLabels(reqs: LabelReq[]) {
    const ctx = this.ctx;
    reqs.sort((a, b) => b.pri - a.pri);
    const placed: [number, number, number, number][] = [];
    const visible = Math.min(this.w * this.h, Math.PI * (this.radius * this.zoom) ** 2);
    const budget = Math.max(10, Math.round(visible / 6500));
    let count = 0;
    for (const L of reqs) {
      if (count >= budget && L.style !== 'selected') break;
      const font = L.style === 'constellation'
        ? '500 9.5px Inter, system-ui, sans-serif'
        : L.style === 'selected' ? '600 13px Inter, system-ui, sans-serif' : '500 11px Inter, system-ui, sans-serif';
      ctx.font = font;
      const tw = ctx.measureText(L.text).width;
      const th = L.style === 'constellation' ? 10 : L.style === 'selected' ? 14 : 12;
      const gap = L.r + (L.style === 'selected' ? 10 : 4);
      const options: [number, number][] = L.style === 'constellation'
        ? [[L.x - tw / 2, L.y - th / 2]]
        : [
          [L.x + gap, L.y - th / 2],
          [L.x - gap - tw, L.y - th / 2],
          [L.x - tw / 2, L.y - gap - th],
          [L.x - tw / 2, L.y + gap],
        ];
      for (const [x, y] of options) {
        const box: [number, number, number, number] = [x - 2, y - 1, x + tw + 2, y + th + 1];
        if (box[0] < 2 || box[1] < 2 || box[2] > this.w - 2 || box[3] > this.h - 2) continue;
        if (L.style !== 'selected' && placed.some((b) => b[0] < box[2] && b[2] > box[0] && b[1] < box[3] && b[3] > box[1])) continue;
        placed.push(box);
        if (L.style === 'selected') {
          ctx.fillStyle = 'rgba(11, 15, 26, 0.75)';
          roundRect(ctx, box[0] - 3, box[1] - 2, box[2] - box[0] + 6, box[3] - box[1] + 4, 5);
          ctx.fill();
        }
        ctx.fillStyle = L.style === 'selected' ? PALETTE.accent : L.color;
        ctx.textBaseline = 'top';
        ctx.fillText(L.text, x, y);
        ctx.textBaseline = 'alphabetic';
        count++;
        break;
      }
    }
    this.labelCount = count;
  }
}

// ------------------------------------------------------------------ utils
const magMemo = new Map<string, number>();
function magCache(body: A.Body, date: Date): number {
  const key = `${body}:${Math.floor(date.getTime() / 3600e3)}`;
  let m = magMemo.get(key);
  if (m === undefined) {
    try {
      m = A.Illumination(body, A.MakeTime(date)).mag;
    } catch {
      m = 99;
    }
    if (magMemo.size > 200) magMemo.clear();
    magMemo.set(key, m);
  }
  return m;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
