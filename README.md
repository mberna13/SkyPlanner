# Sky Planner

A web app that shows what's in the sky from where you are, right now and through tonight, and tells you when each object is best placed for the naked eye, binoculars or a Seestar S50.

It runs entirely in the browser: no server, no account. Phones, tablets and desktops share one codebase with three layouts:

| Screen width | Layout |
|---|---|
| under 760 px (phone) | Sky or Tonight, switched with the bottom tabs; details slide up as a sheet |
| 760–1199 px (tablet) | Sky on the left, Tonight or details in a side panel |
| 1200 px and up (desktop) | Tonight · Sky · Details side by side |

## What it does

- **Sky view.** An all-sky chart for your location and time.
  - **Orientation.** By default it's map style: north up and east on the right, like a map. In Settings you can switch to the traditional overhead style, with east on the left as when you lie back and look up. It shows about 5,000 stars down to magnitude 6, constellation lines and names, the Milky Way band, the planets, the Moon with its phase, and Messier and bright NGC/IC objects. Satellites currently in sunlight appear as moving diamonds with a short track.
  - Tap any object to select it. The selection ring also shows your equipment's field of view: the S50 frame or a binocular circle.
  - Pinch or scroll to zoom and drag to pan. Fainter objects appear as you zoom in.
  - Labels are placed to avoid overlapping, and a bigger screen gets more of them.
  - **Turning the chart.** Twist with two fingers, or press Shift and scroll on a desktop. The turn button (its red needle points to north) steps the chart a quarter turn at a time. In map style, the direction you face goes at the top; in overhead style it goes at the bottom, like a planisphere.
  - **Compass mode** (touch devices, needs HTTPS). The chart turns itself to match the way you're holding the tablet: lying flat with the top edge pointing away from you, or held up in front of you, in portrait or landscape. In map style, the direction you face is at the top, so left and right on the screen match left and right in front of you. Compass readings are corrected from magnetic to true north with NOAA's World Magnetic Model (about 11° in Southern California). Turning the chart by hand switches compass mode off.
  - **Satellites on the chart.** Satellites that are sunlit while your sky is dark are drawn as blue diamonds with a 3-minute track. Ones that are up but in Earth's shadow, or too faint, are small dim squares. A chip counts both. Late at night most satellites are in Earth's shadow, so expect passes mainly in the couple of hours after dusk and before dawn. Selecting a satellite draws its next visible pass across the chart, with start and end times.
- **Tonight.** The night as a timeline (twilight, full dark, Moon up, cloud cover), plus a ranked list of targets for your equipment. Each target shows a small altitude curve and a status such as "Clears 30° at 11:25 PM · in 2h 55m" or "Up now · peaks 76° at 12:48 AM".
  - Filters: All, Moon & planets, Deep sky, Stars, Satellites.
  - The ranking weighs peak altitude, dark time above your minimum altitude, brightness, how well the object fits your field of view, and moonlight.
- **Details.** A full altitude chart for the night with the best window shaded, plus rise, peak and set times with compass directions. You also get Moon distance, a field-of-view diagram, and notes for each piece of equipment ("bigger than the S50 frame — shoot a 3-panel mosaic").
- **Satellite passes.** Uses CelesTrak's ~150 brightest satellites plus the space stations. It predicts each pass where the satellite is sunlit while your sky is dark, with start, peak and end times, directions, and an estimated magnitude. Passes are listed for naked eye and binoculars; the Seestar can't track satellites.
- **Alerts.** Tap the bell to be reminded before an object clears your minimum altitude, or before a pass starts.
  - In-app alerts fire only while Sky Planner is open.
  - **Add to calendar** downloads an `.ics` event with a reminder. Your phone's calendar will alert you even with the app closed.
- **Time preview.** The arrows next to the clock step an hour at a time, so you can see what the sky will look like later. Tap the time to return to now.
- **Red night mode** (moon button) keeps your eyes dark-adapted.
- **Works offline.** Once loaded over HTTPS, the app and its catalogs are cached on the device, and satellite and weather data are kept for several hours. That helps at a dark site with no signal.

## Running it

You need Node.js 20 or newer.

```bash
cd SkyPlanner
npm install
npm run dev        # http://localhost:5173 (also printed: your LAN address for a phone)
```

To build a static site:

```bash
npm run build      # writes dist/
npm run preview    # serves dist/ at http://localhost:4173
```

`dist/` is plain static files with relative paths, so you can copy it into any folder on a web server, such as a NAS web share. A built copy is already included.

### HTTPS matters on phones

Browsers only allow location, notifications, offline caching and "Add to Home Screen" on secure pages: `https://…` or `http://localhost`. If you open the dev server from your phone at `http://192.168.x.x:5173`, the app works, but you'll have to type your latitude and longitude, and alerts and offline mode stay off. Serve `dist/` over HTTPS for the full experience on a phone.

## Settings

Open them with the gear icon. Everything is saved in the browser on that device.

- **Location.** Use "Use my location" (needs HTTPS), or enter latitude, longitude and elevation.
- **How dark is your sky.** Sets the faintest stars drawn and which deep-sky objects are suggested for each piece of equipment.
- **Lowest useful altitude.** The "clears X°" threshold. Raise it if trees or buildings block your low sky.
- **Satellite data URLs.** Defaults to CelesTrak's `visual` and `stations` groups in OMM JSON.

## Data and accuracy

- **Positions.** astronomy-engine converts J2000 catalog positions to altitude/azimuth, including precession, nutation, aberration and atmospheric refraction. I checked star and planet positions against the library's own reference path, and they agree to better than 0.001°. Rise and "clears" times come from 5-minute sampling, so they're good to within a minute or so.
- **Satellites.** SGP4 via satellite.js. Orbital elements go stale, so the app re-downloads them every 8 hours at most. CelesTrak asks clients not to fetch the same data more often than every 2 hours, and "Refresh now" respects that.
  - Brightness is an estimate from range and illumination angle. Only a few satellites (ISS, Tiangong, Hubble) have known standard magnitudes; the rest use a generic value.
- **Clouds.** From the NWS gridpoint forecast, so US locations only. Elsewhere the cloud row simply doesn't appear.
- **Times.** Shown in the device's time zone.

### Rebuilding the catalogs

The JSON in `public/data/` is generated by `scripts/build-catalogs.py` from:

- [d3-celestial data](https://github.com/ofrohn/d3-celestial/tree/master/data): `stars.6.json`, `starnames.json`, `constellations.json`, `constellations.lines.json` (BSD-3-Clause)
- [OpenNGC](https://github.com/mattiaverga/OpenNGC/tree/master/database_files): `NGC.csv`, `addendum.csv` (CC BY-SA 4.0). The derived `dsos.json` carries the same license.

Download those into a `raw/` folder, then run `npm run catalogs`.

## Project layout

```
index.html                 page shell: header, three panels, tab bar, settings dialog
src/main.ts                app state, timers, events, wiring
src/state.ts               settings saved in the browser
src/weather.ts             NWS cloud cover
src/astro/engine.ts        sky math: alt/az, Sun/Moon/planets, night window, curves
src/astro/catalog.ts       loads the bundled catalogs into targets
src/astro/plan.ts          tonight's ranked plan, equipment model, status text
src/astro/satellites.ts    CelesTrak data, SGP4, sunlit test, brightness estimate
src/astro/passes.worker.ts pass prediction in a background thread
src/ui/skyview.ts          the sky canvas: projection, drawing, labels, touch
src/ui/panels.ts           Tonight list and detail panel
src/ui/alerts.ts           notifications and calendar files
public/                    catalogs, icons, manifest, offline service worker
```

## Not built yet

- **Point-at-the-sky AR mode.** The chart already turns with the compass, but it doesn't tilt to show only the patch of sky the device points at.
- **Send to Seestar.** Community projects such as seestar_alp have worked out its control protocol.
- **Alerts with the app closed**, without the calendar step. This needs a small push server, or a native app wrapper.
- **Comets and asteroids** from the Minor Planet Center.
- **Light-pollution lookup** to set sky darkness automatically.
