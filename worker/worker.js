/**
 * Craters from Space - Copernicus relay (Cloudflare Worker)
 *
 * Lets visitors of the public site see Copernicus Sentinel-2 images without an account: the
 * Worker logs in to the Copernicus Data Space Ecosystem with YOUR credentials (stored as
 * encrypted Worker secrets), forwards the dashboard's requests and caches the answers.
 *
 * Only the two requests this dashboard makes are accepted, so the relay cannot be used to spend
 * your quota on anything else:
 *   statistics  scoring of all Sentinel-2 L2A scenes in one period (at most 400 days, from 2016) over one of the
 *               ten volcanoes, daily, at coarse resolution
 *   process     the image of one chosen day (from 2016) over one of the ten volcanoes
 *
 * Settings (Cloudflare dashboard -> Worker -> Settings -> Variables and Secrets):
 *   CDSE_CLIENT_ID      secret   OAuth client ID from the CDSE dashboard
 *   CDSE_CLIENT_SECRET  secret   OAuth client secret
 *   CDSE_CLIENT_ID_2 / CDSE_CLIENT_SECRET_2   optional second account (and _3, _4, _5): used when the first has no processing units left
 *   ALLOWED_ORIGINS     text     e.g. "https://braakhekke.github.io,http://localhost:8000"
 *   CACHE               KV namespace binding (optional but recommended): image cache
 *
 * Endpoints (same paths as scripts/serve.py):
 *   GET  /cdse/ping        -> {"relay":true,"managed":true}
 *   POST /cdse/statistics  -> Statistical API (which scene in the period is clearest)
 *   POST /cdse/process     -> Process API image
 */

const COLLECTION = 'sentinel-2-l2a';                              // scene scoring (scene classification)
const IMAGES = 'sentinel-2-l1c';                                  // the images themselves
/* The ten volcanoes: [lon, lat]. A request must lie within RADIUS_KM of one of them (the images are squares of at most 24 km).
   Keep in step with VOLCANOES in scripts/build_volcanoes.py. */
const CENTRES = [[14.999, 37.748], [15.213, 38.789], [-155.287, 19.421], [130.6589, 31.5772], [-90.8806, 14.4748],
                 [55.708, -21.244], [110.446, -7.54], [-98.622, 19.023], [29.25, -1.52], [40.666, 13.601]];
const RADIUS_KM = 30;
const MAX_PX = 2500;
const MAX_BODY = 20000;                                             // characters; the dashboard's own requests are under 5,000
const FIRST_DAY = '2016-01-01';
const today = () => new Date().toISOString().slice(0, 10);
const dayOk = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) && d >= FIRST_DAY && d <= today();
const MAX_PERIOD_DAYS = 400;
const MIN_STATS_RES = 40;                                           // metres (CRS units); keeps scene scoring cheap
const DAY = 86400;

/* Copernicus accounts: CDSE_CLIENT_ID / CDSE_CLIENT_SECRET, then the same names with _2, _3, _4, _5. They are used in this order; an account that answers
   "insufficient processing units" is put last for an hour, so the next one takes over. */
const clients = env => { const out = []; for (let i = 1; i <= 5; i++) { const x = i === 1 ? '' : '_' + i, id = env['CDSE_CLIENT_ID' + x], secret = env['CDSE_CLIENT_SECRET' + x]; if (id && secret) out.push({ n: i, id, secret }); } return out; };
const tokens = new Map();                                            // account number -> { token, until }, reused while the isolate lives
const spent = new Map();                                             // account number -> time (ms) until which it counts as out of units
const inflight = new Map();                                          // identical requests at the same moment share one fetch and one KV write
/* Fair-use limit per visitor (IP address) for requests that go on to Copernicus (cache hits are free and not counted).
   Kept in the memory of the running Worker instance: no KV writes. It is a brake, not a wall. */
const UPSTREAM_PER_MIN = 90, UPSTREAM_PER_HOUR = 600;
const usage = new Map();                                             // ip -> [timestamps in ms]
function overLimit(ip) {
  const now = Date.now(), list = (usage.get(ip) || []).filter(t => now - t < 3600e3);
  const minute = list.filter(t => now - t < 60e3).length;
  if (minute >= UPSTREAM_PER_MIN || list.length >= UPSTREAM_PER_HOUR) { usage.set(ip, list); return true; }
  list.push(now); usage.set(ip, list);
  if (usage.size > 5000) for (const [k, v] of usage) if (!v.length || now - v[v.length - 1] > 3600e3) usage.delete(k);
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/cdse/ping') return json({ relay: true, managed: true }, 200, cors);

    const route = { '/cdse/statistics': 'statistics', '/cdse/process': 'process' }[url.pathname];
    if (!route) return json({ error: 'Not found' }, 404, cors);
    if (request.method !== 'POST') return json({ error: 'Use POST' }, 405, cors);
    if (!cors['Access-Control-Allow-Origin']) return json({ error: 'Origin not allowed' }, 403, cors);
    if (!clients(env).length)
      return json({ relayError: 'The relay has no Copernicus credentials yet (set CDSE_CLIENT_ID and CDSE_CLIENT_SECRET).' }, 502, cors);

    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'Request too large' }, 413, cors);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'Invalid JSON' }, 400, cors); }
    const problem = route === 'process' ? checkProcess(body) : checkStatistics(body);
    if (problem) return json({ error: `Request not allowed: ${problem}` }, 400, cors);

    // cache lookup
    const key = `${route}:${await sha256(text)}`;
    const hit = await cacheGet(env, key);
    if (hit) return new Response(hit.body, { headers: { ...cors, 'Content-Type': hit.type, 'X-Cache': 'HIT' } });

    // forward to Copernicus (shared with identical requests already on their way)
    let job = inflight.get(key);
    if (!job && overLimit(request.headers.get('CF-Connecting-IP') || 'unknown'))
      return json({ error: 'Too many requests. Please wait a minute and try again.' }, 429, { ...cors, 'Retry-After': '60' });
    if (!job) {
      job = (async () => {
        const accept = route === 'process' ? body.output.responses[0].format.type : 'application/json';   // checkProcess allows image/jpeg and image/png
        const r = await callCdse(env, upstream(env)[route], text, accept);
        const out = { status: r.status, type: r.headers.get('Content-Type') || 'application/octet-stream', data: await r.arrayBuffer() };
        if (r.ok) await cachePut(env, key, out.data, out.type, ttlFor(route, body));
        return out;
      })();
      inflight.set(key, job);
      job.finally(() => inflight.delete(key)).catch(() => {});
    }
    let out;
    try { out = await job; } catch (e) { return json({ relayError: e.message }, 502, cors); }
    return new Response(out.data.slice(0), { status: out.status, headers: { ...cors, 'Content-Type': out.type, 'X-Cache': 'MISS' } });
  }
};

/* ---------- Copernicus ---------- */
function upstream(env) {
  const id = env.CDSE_IDENTITY || 'https://identity.dataspace.copernicus.eu';
  const sh = env.CDSE_SH || 'https://sh.dataspace.copernicus.eu';
  return {
    token: `${id}/auth/realms/CDSE/protocol/openid-connect/token`,
    statistics: `${sh}/statistics/v1`,
    process: `${sh}/process/v1`
  };
}
async function getToken(env, c, force = false) {
  const have = tokens.get(c.n);
  if (!force && have && Date.now() < have.until) return have.token;
  const r = await fetch(upstream(env).token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.id, client_secret: c.secret })
  });
  if (!r.ok) throw new Error(`The relay could not log in to Copernicus with account ${c.n} (HTTP ${r.status}). Check the Worker secrets.`);
  const j = await r.json();
  tokens.set(c.n, { token: j.access_token, until: Date.now() + Math.max(30, (j.expires_in || 300) - 60) * 1000 });
  return j.access_token;
}
async function callCdse(env, target, text, accept) {
  const now = Date.now(), list = clients(env), fresh = list.filter(c => !(spent.get(c.n) > now)), used = list.filter(c => spent.get(c.n) > now);
  let last = null, failure = null;
  for (const c of [...fresh, ...used]) {
    try {
      const go = async force => fetch(target, {
        method: 'POST', body: text,
        headers: { 'Authorization': `Bearer ${await getToken(env, c, force)}`, 'Content-Type': 'application/json', 'Accept': accept }
      });
      let r = await go(false);
      if (r.status === 401) r = await go(true);   // token expired early: log in again once
      if (r.status === 403 && /INSUFFICIENT_PROCESSING_UNITS/.test(await r.clone().text())) { spent.set(c.n, now + 3600e3); last = r; continue; }   // this account is out of units: try the next one
      return r;
    } catch (e) { failure = e; }                 // a login problem with this account: try the next one
  }
  if (last) return last;
  throw failure || new Error('No Copernicus account available.');
}

/* ---------- request checks: only what the dashboard needs ---------- */
function mercToLonLat(x, y) {
  const R = 6378137;
  return [x / R * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
}
function km(lon1, lat1, lon2, lat2) {                                // distance on the globe (haversine)
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
function nearVolcano([w, s, e, n]) {
  if (![w, s, e, n].every(Number.isFinite) || !(w < e && s < n) || e - w > 1 || n - s > 1) return false;   // under about 110 km across
  const lon = (w + e) / 2, lat = (s + n) / 2;
  return CENTRES.some(([x, y]) => km(lon, lat, x, y) <= RADIUS_KM);
}
function checkBounds(inp, collections = [COLLECTION]) {
  if (!inp || !inp.bounds || !Array.isArray(inp.bounds.bbox) || inp.bounds.bbox.length !== 4) return 'bounds';
  const crs = (inp.bounds.properties && inp.bounds.properties.crs) || '';
  let bb = inp.bounds.bbox.map(Number);
  if (/3857/.test(crs)) { const [w, s] = mercToLonLat(bb[0], bb[1]), [e, n] = mercToLonLat(bb[2], bb[3]); bb = [w, s, e, n]; }
  else if (crs && !/4326|CRS84/.test(crs)) return 'coordinate system';
  if (!nearVolcano(bb)) return 'area is not one of the ten volcanoes';
  if (!Array.isArray(inp.data) || inp.data.length !== 1 || !collections.includes(inp.data[0].type)) return 'data collection';
  return null;
}
function checkProcess(b) {
  const inp = b && b.input, out = b && b.output;
  const bad = checkBounds(inp, [COLLECTION, IMAGES]); if (bad) return bad;
  const tr = inp.data[0].dataFilter && inp.data[0].dataFilter.timeRange;
  if (!tr || typeof tr.from !== 'string' || !dayOk(tr.from.slice(0, 10)) || tr.from.slice(10) !== 'T00:00:00Z' ||
      tr.to !== tr.from.slice(0, 10) + 'T23:59:59Z') return 'date (one day from 2016 on)';
  if (!out || !(out.width > 0 && out.width <= MAX_PX) || !(out.height > 0 && out.height <= MAX_PX)) return 'image size';
  if (!Array.isArray(out.responses) || out.responses.length !== 1 ||
      !['image/jpeg', 'image/png'].includes(out.responses[0].format && out.responses[0].format.type)) return 'output format';
  if (typeof b.evalscript !== 'string' || b.evalscript.length > 2500) return 'evalscript';
  return null;
}
function checkStatistics(b) {
  const bad = checkBounds(b && b.input); if (bad) return bad;
  const ag = b.aggregation, tr = ag && ag.timeRange;
  if (!tr || typeof tr.from !== 'string' || typeof tr.to !== 'string' || !/T00:00:00Z$/.test(tr.from) || !/T00:00:00Z$/.test(tr.to)) return 'period';
  const from = tr.from.slice(0, 10), to = tr.to.slice(0, 10);
  if (!dayOk(from) || to < from || (Date.parse(to) - Date.parse(from)) / 864e5 > MAX_PERIOD_DAYS || to > new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10)) return `period (from ${FIRST_DAY}, at most ${MAX_PERIOD_DAYS} days)`;
  if (!ag.aggregationInterval || ag.aggregationInterval.of !== 'P1D') return 'interval';
  if (!(ag.resx >= MIN_STATS_RES && ag.resy >= MIN_STATS_RES)) return 'resolution';
  if (typeof ag.evalscript !== 'string' || ag.evalscript.length > 2500) return 'evalscript';
  if (b.calculations && JSON.stringify(b.calculations).length > 500) return 'calculations';
  return null;
}
/* Images of a fixed day never change: keep them long. Scene scores of a finished period are final;
   a period that is still running gets new acquisitions, so it is refreshed once a day
   (fewer KV writes; the free plan allows 1,000 a day). */
function ttlFor(route, body) {
  if (route === 'process') return 180 * DAY;
  return body.aggregation.timeRange.to.slice(0, 10) < new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10) ? 180 * DAY : DAY;
}

/* ---------- cache: KV if bound, otherwise the edge cache ---------- */
async function cacheGet(env, key) {
  try {
    if (env.CACHE) {
      const v = await env.CACHE.getWithMetadata(key, 'arrayBuffer');
      if (v && v.value) return { body: v.value, type: (v.metadata && v.metadata.type) || 'application/octet-stream' };
    } else if (typeof caches !== 'undefined') {
      const r = await caches.default.match(cacheUrl(key));
      if (r) return { body: await r.arrayBuffer(), type: r.headers.get('Content-Type') };
    }
  } catch {}
  return null;
}
async function cachePut(env, key, data, type, ttl) {
  try {
    if (env.CACHE) return await env.CACHE.put(key, data, { expirationTtl: ttl, metadata: { type } });
    if (typeof caches !== 'undefined')
      await caches.default.put(cacheUrl(key), new Response(data, { headers: { 'Content-Type': type, 'Cache-Control': `public, max-age=${ttl}` } }));
  } catch {}
}
const cacheUrl = key => `https://cratersfromspace-cache.internal/${encodeURIComponent(key)}`;

/* ---------- helpers ---------- */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || 'https://braakhekke.github.io,http://localhost:8000')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Accept',
              'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
