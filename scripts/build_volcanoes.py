#!/usr/bin/env python3
"""
build_volcanoes.py  -  write volcanoes.js for Craters from Space.

    python3 scripts/build_volcanoes.py              writes volcanoes.js
    python3 scripts/build_volcanoes.py --out x.js

Source: Smithsonian Institution, Global Volcanism Program (GVP), Volcanoes of the World, public web service
https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows (layers Smithsonian_VOTW_Holocene_Volcanoes and E3WebApp_Eruptions1960).
Per volcano it takes the facts (elevation, type, country, last eruption year, geological summary) and the eruption records that
overlap the Sentinel-2 era, and turns them into "events": the periods the site shows one satellite scene for.

Event rule (documented on the site):
  * an eruption record of at most 150 days (within the Sentinel-2 era) is one event;
  * a longer record (persistent or continuing activity) is split into one event per calendar year;
  * the scene for an event is searched in its period, which is widened to at least 30 days after the start.
The curated list (VOLCANOES below) is chosen by hand; its footprints are what the images cover.
Leaves the output untouched when nothing changed. Standard library only.
"""
import argparse, datetime as dt, json, os, sys, urllib.parse, urllib.request

WFS = "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows"
FIRST_DAY = dt.date(2016, 1, 1)          # the site's Sentinel-2 imagery starts here
LONG_EVENT_DAYS = 150

# id, GVP volcano number, shown name, half the footprint width in km (the image is a square of 2 x half km around the summit)
VOLCANOES = [
    ("etna",      211060, "Etna",                12),
    ("stromboli", 211040, "Stromboli",            5),
    ("kilauea",   332010, "Kīlauea",             12),
    ("sakurajima",282080, "Sakurajima",           8),
    ("fuego",     342090, "Fuego",                8),
    ("fournaise", 233020, "Piton de la Fournaise",10),
    ("merapi",    263250, "Merapi",               8),
    ("popocatepetl",341090,"Popocatépetl",       10),
    ("nyiragongo",223030, "Nyiragongo",          10),
    ("erta-ale",  221080, "Erta Ale",            10),
]
# GVP lists Sakurajima's cone under the caldera Aira; the note is shown on the site
GVP_NOTE = {"sakurajima": "GVP lists Sakurajima under the Aira caldera (volcano number 282080)."}

def wfs(layer, cql):
    q = urllib.parse.urlencode({"service": "WFS", "version": "1.0.0", "request": "GetFeature", "outputFormat": "application/json",
                                "typeName": "GVP-VOTW:" + layer, "CQL_FILTER": cql})
    with urllib.request.urlopen(urllib.request.Request(WFS + "?" + q, headers={"User-Agent": "cratersfromspace/1.0"}), timeout=120) as r:
        return json.load(r)["features"]

def day(s):
    return dt.date(int(s[:4]), int(s[4:6]), int(s[6:8]))

MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
def label(a, b):
    if a.month == 1 and a.day == 1 and b.month == 12 and b.day == 31 and a.year == b.year: return str(a.year)
    if a.year == b.year: return f"{MON[a.month-1]} {a.year}" if a.month == b.month else f"{MON[a.month-1]}-{MON[b.month-1]} {a.year}"
    return f"{MON[a.month-1]} {a.year} - {MON[b.month-1]} {b.year}"

def events(records, today):
    out = []
    for r in sorted(records, key=lambda p: p["StartDate"]):
        start = day(r["StartDate"]); cont = r["ContinuingEruption"] == "True"
        end = today if cont else day(r["EndDate"])
        a, b = max(start, FIRST_DAY), min(end, today)
        if b < a: continue
        rec = {"start": start.isoformat(), "end": None if cont else end.isoformat(), "vei": r["ExplosivityIndexMax"]}
        pieces = [(a, b)] if (b - a).days <= LONG_EVENT_DAYS else [
            (max(a, dt.date(y, 1, 1)), min(b, dt.date(y, 12, 31))) for y in range(a.year, b.year + 1)]
        for pa, pb in pieces:
            find_to = min(max(pb, pa + dt.timedelta(days=29)), today)       # search window: at least 30 days
            out.append({"label": label(pa, pb), "from": pa.isoformat(), "to": pb.isoformat(), "find": [pa.isoformat(), find_to.isoformat()],
                        "record": rec, "split": len(pieces) > 1})
    for i, e in enumerate(out): e["id"] = i
    return out

def build():
    nums = ",".join(str(v[1]) for v in VOLCANOES)
    info = {f["properties"]["Volcano_Number"]: f["properties"] for f in wfs("Smithsonian_VOTW_Holocene_Volcanoes", f"Volcano_Number IN ({nums})")}
    recs = {}
    for f in wfs("E3WebApp_Eruptions1960", f"VolcanoNumber IN ({nums}) AND (ContinuingEruption='True' OR EndDateYear>={FIRST_DAY.year})"):
        recs.setdefault(f["properties"]["VolcanoNumber"], []).append(f["properties"])
    today = dt.date.today()
    res = []
    for vid, num, name, half in VOLCANOES:
        p = info.get(num)
        if not p: sys.exit(f"GVP has no volcano {num} ({name})")
        ev = events(recs.get(num, []), today)
        res.append({"id": vid, "gvp": num, "name": name, "gvpName": p["Volcano_Name"], "country": p["Country"], "region": p["Region"], "type": p["Primary_Volcano_Type"],
                    "elevation": p["Elevation"], "lat": p["Latitude"], "lon": p["Longitude"], "lastEruption": p["Last_Eruption_Year"], "rock": p["Major_Rock_Type"],
                    "summary": p["Geological_Summary"], "half": half, "note": GVP_NOTE.get(vid, ""), "events": ev})
        print(f"{name:24s} {p['Elevation']:>5} m  last eruption {p['Last_Eruption_Year']}  {len(ev):2d} events  ({len(recs.get(num, []))} GVP records)")
    return res

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "volcanoes.js"))
    a = ap.parse_args()
    data = build()
    text = ("/* Generated by scripts/build_volcanoes.py from the Smithsonian Global Volcanism Program (Volcanoes of the World). Do not edit by hand. */\n"
            "window.VOLCANO_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
    # the build date alone must not count as a change
    old = open(a.out, encoding="utf-8").read() if os.path.exists(a.out) else ""
    if old == text: print("volcanoes.js unchanged"); return
    open(a.out, "w", encoding="utf-8").write(text); print("wrote", a.out)

if __name__ == "__main__":
    main()
