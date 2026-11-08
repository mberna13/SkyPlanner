// Cloud cover from the US National Weather Service gridpoint forecast (US locations only).
import type { Site } from './astro/engine';

export interface CloudForecast {
  /** [startMs, endMs, percent] */
  spans: [number, number, number][];
  fetchedAt: number;
}

const CACHE_KEY = 'sp.clouds.v1';

/** ISO 8601 duration such as PT1H, PT3H, P1DT6H -> ms */
function durMs(d: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d);
  if (!m) return 3600e3;
  return ((+m[1] || 0) * 24 * 60 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 60e3;
}

export async function loadClouds(site: Site): Promise<CloudForecast | null> {
  const key = `${site.lat.toFixed(3)},${site.lon.toFixed(3)}`;
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') as (CloudForecast & { key: string }) | null;
    if (c && c.key === key && Date.now() - c.fetchedAt < 3600e3) return c;
  } catch {
    /* ignore a broken cache */
  }
  try {
    const pts = await fetch(`https://api.weather.gov/points/${site.lat.toFixed(4)},${site.lon.toFixed(4)}`, {
      headers: { Accept: 'application/geo+json' },
    });
    if (!pts.ok) return null;
    const gridUrl = (await pts.json())?.properties?.forecastGridData as string | undefined;
    if (!gridUrl) return null;
    const grid = await fetch(gridUrl, { headers: { Accept: 'application/geo+json' } });
    if (!grid.ok) return null;
    const values = (await grid.json())?.properties?.skyCover?.values as { validTime: string; value: number }[] | undefined;
    if (!values) return null;
    const spans: [number, number, number][] = values.map((v) => {
      const [start, dur] = v.validTime.split('/');
      const s = Date.parse(start);
      return [s, s + durMs(dur), v.value];
    });
    const out = { spans, fetchedAt: Date.now() };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ...out, key }));
    } catch {
      /* fine without a cache */
    }
    return out;
  } catch {
    return null;
  }
}

export function cloudAt(f: CloudForecast | null, ms: number): number | null {
  if (!f) return null;
  for (const [a, b, v] of f.spans) if (ms >= a && ms < b) return v;
  return null;
}
