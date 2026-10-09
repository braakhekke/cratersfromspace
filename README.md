# Craters from Space

Ten of the world's most active volcanoes, seen by Sentinel-2 during their eruptions: Etna, Stromboli, Kīlauea, Sakurajima, Fuego, Piton de la Fournaise, Merapi, Popocatépetl, Nyiragongo and Erta Ale. One clear scene per eruption event since 2016, a compare slider, a timelapse, and picture and video export for sharing. Sister project of [Swiss Glacier Tongues from Space](https://braakhekke.github.io/tonguesfromspace/).

Site: https://braakhekke.github.io/cratersfromspace/

## How it works

- **Events** come from the eruption records of the Smithsonian Global Volcanism Program. Long (persistent) records are split per calendar year.
- **Scenes:** for every event, the clearest Sentinel-2 scene in its period (at most 5 % cloud; otherwise the least cloudy up to 30 %), found with the Copernicus Statistical API.
- **Colours:** natural, shortwave infrared (hot ground glows) and near infrared.
- **No build step:** `index.html` is the whole site. `volcanoes.js` is generated monthly by a GitHub Action.

## Run locally

```
python3 scripts/serve.py        # then open http://localhost:8000
```

You need a free Copernicus Data Space OAuth client (https://shapps.dataspace.copernicus.eu/dashboard/ → User settings → OAuth clients). The public site uses a Cloudflare Worker (`worker/worker.js`) as relay instead.

## Licences

- Code: MIT (`LICENSE`). Own texts: CC BY 4.0.
- Contains modified Copernicus Sentinel data, via the Copernicus Data Space Ecosystem.
- Volcano facts and eruption records: Global Volcanism Program, Smithsonian Institution (https://volcano.si.edu/), Volcanoes of the World, used under the Smithsonian Terms of Use for non-commercial purposes.
- Background: Sentinel-2 cloudless by EOX IT Services (CC BY-NC-SA 4.0). Map and labels: OpenStreetMap contributors, EOX.
- Font: Schibsted Grotesk (SIL OFL 1.1, see `fonts/OFL.txt`).

The site is non-commercial.
