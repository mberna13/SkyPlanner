// Device compass: works out which way the user is facing, so the chart can be turned to match.
//
// "Facing" is the horizontal direction pointing away from the user through the device. That's
// where the top edge points when the device lies flat, or where the back points when it is held
// upright, with a smooth blend in between. Compass readings are magnetic; we add the local
// magnetic declination (World Magnetic Model) to get true north.

const DEG = Math.PI / 180;

/** Heading (degrees east of true/magnetic north, per alpha) the user faces, from W3C device orientation angles. */
export function facingHeading(alpha: number, beta: number, gamma: number, screenAngle: number): number {
  const cA = Math.cos(alpha * DEG), sA = Math.sin(alpha * DEG);
  const cB = Math.cos(beta * DEG), sB = Math.sin(beta * DEG);
  const cG = Math.cos(gamma * DEG), sG = Math.sin(gamma * DEG);
  // Device axes in the Earth frame (x = east, y = north, z = up): columns of R = Rz(alpha) Rx(beta) Ry(gamma).
  const xAxis = [cA * cG - sA * sB * sG, cG * sA + cA * sB * sG, -cB * sG];
  const yAxis = [-cB * sA, cA * cB, sB];
  const zAxis = [cG * sA * sB + cA * sG, sA * sG - cA * cG * sB, cB * cG];
  // The screen's "up" depends on whether it's in portrait or landscape.
  const th = screenAngle * DEG;
  const up = [0, 1, 2].map((i) => Math.cos(th) * yAxis[i] + Math.sin(th) * xAxis[i]);
  // Away from the user: screen-up when flat, out of the back when upright.
  const vx = up[0] - zAxis[0];
  const vy = up[1] - zAxis[1];
  const h = Math.atan2(vx, vy) / DEG;
  return (h + 360) % 360;
}

function wrap180(d: number) {
  return ((d + 540) % 360) - 180;
}

function screenAngle(): number {
  const so = (screen as Screen & { orientation?: ScreenOrientation }).orientation;
  if (so && typeof so.angle === 'number') return so.angle;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? (legacy + 360) % 360 : 0;
}

type OrientationEvt = DeviceOrientationEvent & { webkitCompassHeading?: number };

export class DeviceCompass {
  private smoothed: number | null = null;
  private decl = 0;
  private iosOffset: number | null = null;
  private gotAbsolute = false;
  private running = false;
  private frame = 0;
  private lastReading = 0;

  constructor(private onHeading: (trueHeading: number) => void) {}

  /** Touch devices that expose orientation events; desktops don't get the button. */
  static likelyAvailable(): boolean {
    return 'DeviceOrientationEvent' in window && navigator.maxTouchPoints > 0;
  }

  get active() {
    return this.running;
  }

  /**
   * Must be called from a tap: iOS only allows the permission prompt during a user gesture.
   * Resolves to a reason string on failure.
   */
  async start(lat: number, lon: number): Promise<'ok' | 'denied' | 'no-sensor' | 'insecure'> {
    if (!window.isSecureContext) return 'insecure';
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
    if (!DOE) return 'no-sensor';
    if (typeof DOE.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) !== 'granted') return 'denied';
      } catch {
        return 'denied';
      }
    }
    this.running = true;
    this.smoothed = null;
    this.iosOffset = null;
    this.gotAbsolute = false;
    this.lastReading = 0;
    window.addEventListener('deviceorientationabsolute', this.onAbsolute as EventListener);
    window.addEventListener('deviceorientation', this.onRelative as EventListener);
    // Magnetic declination, loaded only when the compass is used.
    import('geomagnetism')
      .then((mod) => {
        const g = (mod as unknown as { model?: typeof mod.model; default?: typeof mod }).model ?? (mod as unknown as { default: typeof mod }).default.model;
        this.decl = g(new Date()).point([lat, lon]).decl;
      })
      .catch(() => {
        this.decl = 0;
      });
    // No readings within a few seconds means there's no usable sensor.
    await new Promise((r) => setTimeout(r, 2500));
    if (!this.lastReading) {
      this.stop();
      return 'no-sensor';
    }
    return 'ok';
  }

  stop() {
    this.running = false;
    window.removeEventListener('deviceorientationabsolute', this.onAbsolute as EventListener);
    window.removeEventListener('deviceorientation', this.onRelative as EventListener);
    cancelAnimationFrame(this.frame);
  }

  private onAbsolute = (e: DeviceOrientationEvent) => {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    this.gotAbsolute = true;
    this.push(facingHeading(e.alpha, e.beta, e.gamma, screenAngle()));
  };

  private onRelative = (e: OrientationEvt) => {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      // iOS: alpha is relative to an arbitrary start; webkitCompassHeading is the flat-device
      // magnetic heading. Learn the offset while the device is roughly flat, then reuse it.
      const flat = Math.abs(e.beta) < 50 && Math.abs(e.gamma) < 50;
      const offset = wrap180(e.webkitCompassHeading - (360 - e.alpha));
      if (this.iosOffset === null || flat) {
        this.iosOffset = this.iosOffset === null ? offset : this.iosOffset + 0.1 * wrap180(offset - this.iosOffset);
      }
      this.push(facingHeading(e.alpha - this.iosOffset, e.beta, e.gamma, screenAngle()));
      return;
    }
    if (!this.gotAbsolute && e.absolute) this.push(facingHeading(e.alpha, e.beta, e.gamma, screenAngle()));
  };

  private push(magnetic: number) {
    this.lastReading = Date.now();
    const h = (magnetic + this.decl + 360) % 360;
    this.smoothed = this.smoothed === null ? h : (this.smoothed + 0.2 * wrap180(h - this.smoothed) + 360) % 360;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      if (this.running && this.smoothed !== null) this.onHeading(this.smoothed);
    });
  }
}
