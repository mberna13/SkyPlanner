#!/usr/bin/env python3
"""Turn the raw d3-celestial and OpenNGC files into compact JSON for the app.

Usage: python3 scripts/build-catalogs.py <raw-dir> <out-dir>
Raw sources (download into <raw-dir>):
  https://github.com/ofrohn/d3-celestial/tree/master/data  stars.6.json starnames.json
      constellations.json constellations.lines.json
  https://github.com/mattiaverga/OpenNGC/tree/master/database_files  NGC.csv addendum.csv
"""
import csv, json, sys, os

raw, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)

def ra_h(lon):  # d3-celestial stores RA as longitude in degrees, -180..180
    return round(((lon + 360) % 360) / 15, 5)

def r(x, n=4):
    return round(x, n)

# ---- stars ----
stars = json.load(open(f"{raw}/stars.6.json"))["features"]
names = json.load(open(f"{raw}/starnames.json"))
star_rows = []
for f in stars:
    hip = f["id"]
    lon, dec = f["geometry"]["coordinates"]
    p = f["properties"]
    n = names.get(str(hip), {})
    proper = n.get("name", "") or ""
    desig = ""
    if n.get("bayer"):
        desig = f'{n["bayer"]} {n.get("c", "")}'.strip()
    elif n.get("flam"):
        desig = f'{n["flam"]} {n.get("c", "")}'.strip()
    try:
        bv = round(float(p.get("bv") or 0.6), 2)
    except ValueError:
        bv = 0.6
    star_rows.append([ra_h(lon), r(dec), round(p["mag"], 2), bv, proper, desig, hip])
star_rows.sort(key=lambda s: s[2])
json.dump(star_rows, open(f"{out}/stars.json", "w"), ensure_ascii=False, separators=(",", ":"))

# ---- constellations ----
cons_names = {f["id"]: f for f in json.load(open(f"{raw}/constellations.json"))["features"]}
lines = json.load(open(f"{raw}/constellations.lines.json"))["features"]
cons = []
for f in lines:
    cid = f["id"]
    meta = cons_names.get(cid)
    polys = [[[ra_h(lon), r(dec, 3)] for lon, dec in seg] for seg in f["geometry"]["coordinates"]]
    label = None
    if meta:
        lon, dec = meta["geometry"]["coordinates"]
        label = [ra_h(lon), r(dec, 2)]
    cons.append({"id": cid, "name": meta["properties"]["name"] if meta else cid,
                 "rank": int(f["properties"].get("rank", 3)), "label": label, "lines": polys})
json.dump(cons, open(f"{out}/constellations.json", "w"), ensure_ascii=False, separators=(",", ":"))

# ---- deep-sky objects ----
TYPES = {
    "G": "Galaxy", "GPair": "Galaxy pair", "GTrpl": "Galaxy triplet", "GGroup": "Galaxy group",
    "OCl": "Open cluster", "GCl": "Globular cluster", "PN": "Planetary nebula",
    "HII": "Emission nebula", "EmN": "Emission nebula", "Neb": "Nebula", "RfN": "Reflection nebula",
    "Cl+N": "Cluster with nebula", "SNR": "Supernova remnant", "DrkN": "Dark nebula",
    "*Ass": "Star cloud / asterism", "**": "Double star",
}
GROUP = {"Galaxy": "galaxy", "Galaxy pair": "galaxy", "Galaxy triplet": "galaxy", "Galaxy group": "galaxy",
         "Open cluster": "cluster", "Globular cluster": "globular", "Star cloud / asterism": "cluster",
         "Double star": "cluster"}

def hms(s):
    h, m, sec = s.split(":")
    return int(h) + int(m) / 60 + float(sec) / 3600

def dms(s):
    sign = -1 if s.startswith("-") else 1
    d, m, sec = s.lstrip("+-").split(":")
    return sign * (int(d) + int(m) / 60 + float(sec) / 3600)

def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None

def catalog_id(name):
    for pre in ("NGC", "IC"):
        if name.startswith(pre):
            return f"{pre} {int(name[len(pre):].rstrip('ABCDEFGHIJKLMNOPQRSTUVWXYZ') or 0)}"
    return name

dsos = []
for fn in ("NGC.csv", "addendum.csv"):
    for row in csv.DictReader(open(f"{raw}/{fn}"), delimiter=";"):
        t = row["Type"]
        if t in ("Dup", "NonEx", "*", "Other", "Nova") or not row["RA"]:
            continue
        typ = TYPES.get(t)
        if not typ:
            continue
        messier = int(row["M"]) if row["M"].strip() else None
        vmag = num(row["V-Mag"])
        bmag = num(row["B-Mag"])
        mag = vmag if vmag is not None else (bmag - 0.8 if bmag is not None else None)
        common = [c.strip() for c in (row["Common names"] or "").split(",") if c.strip()]
        major = num(row["MajAx"])
        minor = num(row["MinAx"]) or major
        keep = messier is not None or (mag is not None and mag <= 8.5) or \
               (common and (mag is None or mag <= 10.5) and (major or 0) >= 5 and t != "G")
        if t == "**" and messier is None:
            keep = False
        if not keep:
            continue
        cat = f"M{messier}" if messier else catalog_id(row["Name"])
        other = catalog_id(row["Name"]) if messier and row["Name"].startswith(("NGC", "IC")) else ""
        dsos.append({
            "id": cat.replace(" ", ""),
            "cat": cat, "alt": other,
            "name": common[0] if common else "",
            "type": typ, "group": GROUP.get(typ, "nebula"),
            "ra": round(hms(row["RA"]), 5), "dec": round(dms(row["Dec"]), 4),
            "mag": round(mag, 1) if mag is not None else None,
            "size": [round(major, 1) if major else None, round(minor, 1) if minor else None],
            "m": messier,
        })
# drop duplicates of Messier objects that also appear under NGC numbers
seen = set()
uniq = []
for d in sorted(dsos, key=lambda d: (d["m"] is None, d["mag"] if d["mag"] is not None else 99)):
    key = d["id"]
    if key in seen:
        continue
    seen.add(key)
    uniq.append(d)
json.dump(uniq, open(f"{out}/dsos.json", "w"), ensure_ascii=False, separators=(",", ":"))

print(f"stars {len(star_rows)}  constellations {len(cons)}  dsos {len(uniq)} "
      f"(messier {sum(1 for d in uniq if d['m'])})")
