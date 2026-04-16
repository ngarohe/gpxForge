# Acknowledgements

## processGPX

`src/lib/processGPX/process-gpx.js` is a lightly modified copy of
[djconnel/processGPX](https://github.com/djconnel/processGPX) by **Dan Connelly**.

Dan gave verbal permission to use his code under the MIT License.
Two bug fixes were applied to the copy in this repository:

- `SQRT2PI` constant was undefined — added `const SQRT2PI = Math.sqrt(2 * PI)`
- `note()` log calls produced console spam on every run — silenced behind
  `globalThis.processGPXVerbose` opt-in flag

All other logic is Dan's original work. The original repository has no LICENSE
file; the MIT grant is by verbal permission from the author.

---

## Inspiration: jsmattsonjr/brunnels

The bridge/tunnel detection pipeline (`src/pipeline/2-brunnels.js`) was
inspired by the conceptual approach in
[jsmattsonjr/brunnels](https://github.com/jsmattsonjr/brunnels) by
**Jim Mattson** (MIT License).

No code from that repository was used. The GPXForge implementation is an
independent JavaScript re-implementation using the same general idea
(query Overpass for OSM bridge/tunnel ways, project them onto the GPS route,
classify by elevation deviation).

---

## Open Data and Services

GPXForge relies on several free public services:

| Service | Provider | Used For |
|---------|----------|----------|
| Valhalla routing | OpenStreetMap community (`valhalla1.openstreetmap.de`) | Road snapping, route building |
| Overpass API | OpenStreetMap community (multiple mirrors) | Bridge/tunnel OSM geometry |
| OpenTopoData | Adam Bossy | Elevation gap-fill at trim seams |
| Nominatim | OpenStreetMap community | Place search and geocoding |
| OSM map tiles | OpenStreetMap contributors | Street map layer |
| ArcGIS satellite tiles | Esri / various sources | Satellite imagery layer |

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
available under the [Open Database License](https://opendatacommons.org/licenses/odbl/).

National LIDAR elevation data is fetched from official government survey
services (Maanmittauslaitos, Dataforsyningen, IGN, BKG, GUGiK, Geonorge,
Maaamet, PDOK, Swisstopo, USGS 3DEP, and others). Each service has its own
terms of use; please review them before deploying this software in production.
