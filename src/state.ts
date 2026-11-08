// App settings (saved in this browser) and the in-memory app state.
import type { Site } from './astro/engine';
import type { EquipmentId } from './astro/plan';
import { DEFAULT_SAT_URLS } from './astro/satellites';

export interface Alert {
  id: string;
  targetId: string;
  name: string;
  /** When the notification fires (ms). */
  at: number;
  /** The event it is for, e.g. "clears 30° at 11:25 PM". */
  what: string;
}

export interface Settings {
  site: Site | null;
  equipment: EquipmentId;
  skyLimit: number;
  minAlt: number;
  leadMin: number;
  nightRed: boolean;
  showConstellations: boolean;
  showConstNames: boolean;
  showDsos: boolean;
  showSats: boolean;
  showMilkyWay: boolean;
  /** 'map': east on the right, like a map. 'overhead': east on the left, as when looking up. */
  chartStyle: 'map' | 'overhead';
  satUrls: string[];
  alerts: Alert[];
}

const KEY = 'sp.settings.v1';

const DEFAULTS: Settings = {
  site: null,
  equipment: 'seestar',
  skyLimit: 5.0,
  minAlt: 30,
  leadMin: 30,
  nightRed: false,
  showConstellations: true,
  showConstNames: true,
  showDsos: true,
  showSats: true,
  showMilkyWay: true,
  chartStyle: 'map',
  satUrls: DEFAULT_SAT_URLS,
  alerts: [],
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    return { ...structuredClone(DEFAULTS), ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode or storage blocked: settings last for this visit only */
  }
}

export type View = 'sky' | 'tonight';
