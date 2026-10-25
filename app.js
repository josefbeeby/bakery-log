/* Bakery Log — all the app's behaviour lives in this file.
 *
 * Each bakery is saved as an object like this:
 * {
 *   id, name, address, lat, lng,
 *   status: 'want' | 'visited',
 *   openingHours: 'Mo-Fr 07:00-18:00; Sa 08:00-16:00' (from OpenStreetMap, may be empty),
 *   osmId: 'node/123' (so the same place isn't added twice from search),
 *   wantToTry: [{ id, text }],
 *   items: [{ id, name, rating: 'F'|'D'|'C'|'B'|'A'|'S'|'', notes }],
 *   createdAt, visitedAt
 * }
 */

const STORE_KEY = 'bakery-log-v1';
const TORONTO = [43.6532, -79.3832];
const TORONTO_BOX = '-79.64,43.86,-79.11,43.57'; // search only inside the city
const RATINGS = ['F', 'D', 'C', 'B', 'A', 'S'];
const NOMINATIM = 'https://nominatim.openstreetmap.org';

const $ = (sel) => document.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Saving and loading ---------- */

let bakeries = load();

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(bakeries));
  renderList();
}
const getBakery = (id) => bakeries.find((b) => b.id === id);

/* ---------- Map ---------- */

const map = L.map('map', { zoomControl: false }).setView(TORONTO, 13);
L.control.zoom({ position: 'bottomright' }).addTo(map);
// A plain light-grey map style ("Positron") from OpenFreeMap — free, no account needed.
L.maplibreGL({
  style: 'https://tiles.openfreemap.org/styles/positron',
  attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const markers = {};      // bakery id -> Leaflet marker
let tempMarker = null;   // grey pin shown while adding a bakery
let pendingPlace = null; // details of the place being added
let placing = false;     // true while waiting for a tap in "Drop a pin" mode
let openId = null;       // bakery currently shown in the info panel

function pinIcon(status, selected = false) {
  const symbol = status === 'visited' ? '✓' : status === 'want' ? '★' : '+';
  return L.divIcon({
    className: '',
    html: `<div class="pin pin-${status}${selected ? ' selected' : ''}"><span>${symbol}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 41], // the pin's point, after the -45° rotation
  });
}

function drawMarker(b) {
  if (markers[b.id]) map.removeLayer(markers[b.id]);
  const m = L.marker([b.lat, b.lng], { icon: pinIcon(b.status, b.id === openId), title: b.name }).addTo(map);
  m.on('click', () => openSheet(b.id));
  markers[b.id] = m;
}

function clearTemp() {
  if (tempMarker) map.removeLayer(tempMarker);
  tempMarker = null;
}

map.on('click', async (e) => {
  if (!placing) { closeSheet(); return; }
  stopPlacing();
  const { lat, lng } = e.latlng;
  clearTemp();
  tempMarker = L.marker([lat, lng], { icon: pinIcon('temp') }).addTo(map);
  // Ask OpenStreetMap what is at this spot, to pre-fill the name and address.
  let place = { lat, lng, name: '', address: '', openingHours: '', osmId: null };
  try {
    const res = await fetch(`${NOMINATIM}/reverse?` + new URLSearchParams({
      lat, lon: lng, format: 'jsonv2', addressdetails: 1, extratags: 1, zoom: 18,
    }));
    const r = await res.json();
    const isShop = BAKERY_TYPES.includes(r.type);
    place = {
      ...place,
      name: isShop ? (r.name || '') : '',
      address: shortAddress(r.address),
      openingHours: isShop ? (r.extratags?.opening_hours || '') : '',
      osmId: isShop ? `${r.osm_type}/${r.osm_id}` : null,
    };
  } catch { /* offline or lookup failed: user can type it in */ }
  openAddDialog(place);
});

function startPlacing() {
  placing = true;
  closeSheet();
  document.body.classList.add('placing');
  $('#fabs').hidden = true;
  $('#place-hint').hidden = false;
}
function stopPlacing() {
  placing = false;
  document.body.classList.remove('placing');
  $('#fabs').hidden = false;
  $('#place-hint').hidden = true;
}
$('#place-btn').addEventListener('click', startPlacing);
$('#place-cancel').addEventListener('click', stopPlacing);

/* ---------- Your location (blue dot) ---------- */

let myPos = null;        // [lat, lng] once the phone reports where you are
let myDot = null, myAccuracy = null;
let watchId = null;
let centerOnNextFix = false;
let waitingForFix = [];  // things to do as soon as we know where you are

function startLocating({ center = true } = {}) {
  if (!navigator.geolocation) { alert('This browser can’t share your location.'); return; }
  if (myPos && center) map.setView(myPos, 16);
  if (watchId !== null) return; // already tracking
  centerOnNextFix = center && !myPos;
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError,
    { enableHighAccuracy: true, maximumAge: 10000 });
}

function onPosition(p) {
  myPos = [p.coords.latitude, p.coords.longitude];
  if (!myDot) {
    myAccuracy = L.circle(myPos, { radius: p.coords.accuracy, stroke: false, fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false }).addTo(map);
    myDot = L.circleMarker(myPos, { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1, interactive: false }).addTo(map);
  } else {
    myDot.setLatLng(myPos);
    myAccuracy.setLatLng(myPos).setRadius(p.coords.accuracy);
  }
  if (centerOnNextFix) { map.setView(myPos, 16); centerOnNextFix = false; }
  const todo = waitingForFix;
  waitingForFix = [];
  todo.forEach((fn) => fn());
}

function onPositionError(err) {
  navigator.geolocation.clearWatch(watchId);
  watchId = null;
  waitingForFix = [];
  alert(err.code === err.PERMISSION_DENIED
    ? 'Location is turned off for this app. To use it, allow location access for this site in your phone’s settings.'
    : 'Couldn’t find your location right now. Try again in a moment.');
}

function whenLocated(fn) {
  if (myPos) { fn(); return; }
  waitingForFix.push(fn);
  startLocating({ center: false });
}

// "Locate me" button, stacked above the zoom buttons.
const LocateControl = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd() {
    const btn = L.DomUtil.create('button', 'locate-btn leaflet-bar');
    btn.type = 'button';
    btn.title = 'Show my location';
    btn.innerHTML = '◎';
    L.DomEvent.disableClickPropagation(btn);
    btn.addEventListener('click', () => startLocating());
    return btn;
  },
});
new LocateControl().addTo(map);

// If you've already allowed location before, show the dot straight away.
navigator.permissions?.query({ name: 'geolocation' })
  .then((s) => { if (s.state === 'granted') startLocating({ center: false }); })
  .catch(() => {});

/* ---------- Nearest bakeries ---------- */

// Straight-line distance in km between two [lat, lng] points.
function distanceKm([lat1, lng1], [lat2, lng2]) {
  const rad = (d) => d * Math.PI / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
const fmtDistance = (km) => km < 1 ? `${Math.round(km * 1000 / 10) * 10} m` : `${km.toFixed(1)} km`;

$('#nearby-btn').addEventListener('click', () => {
  const wishList = bakeries.filter((b) => b.status === 'want');
  if (!wishList.length) { alert('Your “Want to visit” list is empty — add a bakery first.'); return; }
  whenLocated(() => showNearby(wishList));
});

/* ---------- Random pick ---------- */

const RANDOM_RADIUS_KM = 10;
const OSM_PAGES = 5; // up to 5 × 40 bakeries per lookup
let randomSource = 'want';  // 'want' (my wish list) or 'any' (any bakery on the map)
let lastRandomKey = null;   // so the same bakery isn't picked twice in a row
let discoveredPlace = null; // a random bakery that isn't on your lists yet
const OSM_CACHE_KEY = 'bakery-log-osm-cache';
const OSM_CACHE_HOURS = 24;
let osmBakeryCache = null;  // { pos, time, list } — saves looking them up again on every reroll
try { osmBakeryCache = JSON.parse(localStorage.getItem(OSM_CACHE_KEY)); } catch {}

const randomDialog = $('#random-dialog');
$('#random-btn').addEventListener('click', () => randomDialog.showModal());
$('#random-cancel').addEventListener('click', () => randomDialog.close());
randomDialog.addEventListener('click', (e) => {
  const choice = e.target.closest('[data-source]');
  if (!choice) return;
  randomSource = choice.dataset.source;
  randomDialog.close();
  runRandom();
});

function runRandom() {
  if (randomSource === 'want' && !bakeries.some((b) => b.status === 'want')) {
    alert('Your “Want to visit” list is empty — add a bakery first.');
    return;
  }
  whenLocated(() => (randomSource === 'want' ? pickFromWishList() : pickAnyBakery()));
}

// Picks at random, avoiding the previous pick when there's a choice.
function pickOne(list, keyOf) {
  const choices = list.length > 1 ? list.filter((x) => keyOf(x) !== lastRandomKey) : list;
  const pick = choices[Math.floor(Math.random() * choices.length)];
  lastRandomKey = keyOf(pick);
  return pick;
}

function pickFromWishList() {
  const inRange = bakeries.filter((b) => b.status === 'want' &&
    distanceKm(myPos, [b.lat, b.lng]) <= RANDOM_RADIUS_KM);
  if (!inRange.length) {
    alert(`None of your “Want to visit” bakeries are within ${RANDOM_RADIUS_KM} km of you.`);
    return;
  }
  const pick = pickOne(inRange, (b) => b.id);
  map.setView([pick.lat, pick.lng], 16);
  openSheet(pick.id, { fromRandom: true });
  showToast(`🎲 Random pick · ${fmtDistance(distanceKm(myPos, [pick.lat, pick.lng]))} away`);
}

async function pickAnyBakery() {
  let list;
  try {
    list = await nearbyOsmBakeries();
  } catch {
    alert('Couldn’t look up nearby bakeries just now — check your connection and try again.');
    return;
  }
  if (!list.length) { alert(`No bakeries found within ${RANDOM_RADIUS_KM} km of you.`); return; }
  const pick = pickOne(list, (p) => p.osmId);
  const km = distanceKm(myPos, [pick.lat, pick.lng]);
  showToast(`🎲 Random pick · ${fmtDistance(km)} away · 1 of ${list.length} nearby`);
  // Already on one of your lists? Show your entry for it.
  const saved = bakeries.find((b) => b.osmId === pick.osmId) ||
    bakeries.find((b) => distanceKm([b.lat, b.lng], [pick.lat, pick.lng]) < 0.04);
  if (saved) {
    map.setView([saved.lat, saved.lng], 16);
    openSheet(saved.id, { fromRandom: true });
  } else {
    showDiscovered(pick);
  }
}

// Bakeries OpenStreetMap knows about within 10 km of you.
// The search service returns 40 at a time, so we ask a few times ("more, but not these ones").
async function nearbyOsmBakeries() {
  const fresh = osmBakeryCache && Date.now() - osmBakeryCache.time < OSM_CACHE_HOURS * 3600000;
  if (fresh && distanceKm(osmBakeryCache.pos, myPos) < 1) return osmBakeryCache.list;
  showToast('🔎 Finding bakeries near you…', 30000);
  const [lat, lng] = myPos;
  const dLat = RANDOM_RADIUS_KM / 111, dLng = RANDOM_RADIUS_KM / (111 * Math.cos(lat * Math.PI / 180));
  const box = [lng - dLng, lat + dLat, lng + dLng, lat - dLat].map((x) => x.toFixed(4)).join(',');
  const found = [];
  try {
    for (let page = 0; page < OSM_PAGES; page++) {
      const params = new URLSearchParams({
        q: 'bakery', format: 'jsonv2', addressdetails: 1, extratags: 1, limit: 40, viewbox: box, bounded: 1,
      });
      if (found.length) params.set('exclude_place_ids', found.map((r) => r.place_id).join(','));
      if (page > 0) await new Promise((r) => setTimeout(r, 1100)); // the service asks for max 1 request a second
      const res = await fetch(`${NOMINATIM}/search?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const results = await res.json();
      found.push(...results);
      if (results.length < 40) break; // that's all of them
    }
  } finally {
    $('#toast').hidden = true;
  }
  const list = found
    .map((r) => ({
      name: r.name,
      lat: +r.lat,
      lng: +r.lon,
      address: shortAddress(r.address),
      openingHours: r.extratags?.opening_hours || '',
      osmId: `${r.osm_type}/${r.osm_id}`,
    }))
    .filter((p) => p.name && distanceKm(myPos, [p.lat, p.lng]) <= RANDOM_RADIUS_KM); // box corners → circle
  osmBakeryCache = { pos: myPos, time: Date.now(), list };
  try { localStorage.setItem(OSM_CACHE_KEY, JSON.stringify(osmBakeryCache)); } catch {}
  return list;
}

// Preview panel for a random bakery that isn't on your lists.
function showDiscovered(place) {
  closeSheet();
  discoveredPlace = place;
  tempMarker = L.marker([place.lat, place.lng], { icon: pinIcon('temp') }).addTo(map);
  map.setView([place.lat, place.lng], 16);
  const hours = hoursToday(place);
  sheetBody.innerHTML = `
    <button type="button" class="reroll" data-action="reroll">🎲 Pick another</button>
    <h2>${esc(place.name)}</h2>
    ${place.address ? `<p class="meta">📍 ${esc(place.address)}</p>` : ''}
    ${hours ? `<p class="meta hours">🕒 ${esc(hours)}</p>` : ''}
    <p class="prompt" style="margin-top:10px">Not on your lists yet.</p>
    <div class="status-toggle">
      <button type="button" data-action="add-discovered" data-status="want" class="on want">★ Add to Want to visit</button>
      <button type="button" data-action="add-discovered" data-status="visited" class="on visited">✓ I’ve been here</button>
    </div>`;
  sheet.hidden = false;
  sheet.scrollTop = 0;
  panAboveSheet(place.lat, place.lng);
}

let toastTimer;
function showToast(text, ms = 3000) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, ms);
}

function showNearby(wishList) {
  const nearest = wishList
    .map((b) => ({ b, km: distanceKm(myPos, [b.lat, b.lng]) }))
    .sort((x, y) => x.km - y.km)
    .slice(0, 3);
  closeSheet();
  sheetBody.innerHTML = `
    <h2>Closest on your wish list</h2>
    <p class="prompt">Distances are as the crow flies.</p>
    ${nearest.map(({ b, km }) => {
      const hours = hoursToday(b);
      return `<div class="card" data-action="open-bakery" data-id="${b.id}">
        <div class="near-top"><h3>${esc(b.name || 'Unnamed bakery')}</h3><span class="dist">${fmtDistance(km)}</span></div>
        ${b.address ? `<p class="meta">📍 ${esc(b.address)}</p>` : ''}
        ${hours ? `<p class="meta hours">🕒 ${esc(hours)}</p>` : ''}
        ${b.wantToTry.length ? `<p class="meta">Want to try: ${esc(b.wantToTry.map((t) => t.text).join(', '))}</p>` : ''}
      </div>`;
    }).join('')}`;
  sheet.hidden = false;
  sheet.scrollTop = 0;
  // Zoom out just enough to show you and those bakeries together.
  map.fitBounds(L.latLngBounds([myPos, ...nearest.map(({ b }) => [b.lat, b.lng])]),
    { paddingTopLeft: [40, 90], paddingBottomRight: [40, sheet.offsetHeight + 40], maxZoom: 16 });
}

/* ---------- Search ---------- */

function shortAddress(a) {
  if (!a) return '';
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const area = a.neighbourhood || a.suburb || a.quarter || a.city_district || '';
  return [street, area].filter(Boolean).join(', ');
}

const BAKERY_TYPES = ['bakery', 'pastry', 'confectionery', 'cafe', 'deli'];

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  const list = $('#search-results');
  if (!q) { list.hidden = true; return; }
  $('#search-input').blur();
  list.hidden = false;
  list.innerHTML = '<li class="r-msg">Searching…</li>';
  try {
    const res = await fetch(`${NOMINATIM}/search?` + new URLSearchParams({
      q, format: 'jsonv2', addressdetails: 1, extratags: 1, limit: 10,
      viewbox: TORONTO_BOX, bounded: 1, countrycodes: 'ca',
    }));
    let results = await res.json();
    // Show bakeries/cafés first.
    results.sort((a, b) => BAKERY_TYPES.includes(b.type) - BAKERY_TYPES.includes(a.type));
    if (!results.length) {
      list.innerHTML = '<li class="r-msg">No matches in Toronto. Try a different spelling, or use “Drop a pin”.</li>';
      return;
    }
    list.innerHTML = results.map((r, i) => `
      <li data-i="${i}">
        <div class="r-name">${esc(r.name || r.display_name.split(',')[0])}
          ${BAKERY_TYPES.includes(r.type) ? `<span class="r-tag">${esc(r.type)}</span>` : ''}</div>
        <div class="r-addr">${esc(shortAddress(r.address) || r.display_name)}</div>
      </li>`).join('');
    list.onclick = (ev) => {
      const li = ev.target.closest('li[data-i]');
      if (!li) return;
      const r = results[+li.dataset.i];
      list.hidden = true;
      pickSearchResult(r);
    };
  } catch {
    list.innerHTML = '<li class="r-msg">Search failed — check your internet connection.</li>';
  }
});

$('#search-input').addEventListener('input', (e) => {
  if (!e.target.value) $('#search-results').hidden = true;
});

function pickSearchResult(r) {
  const osmId = `${r.osm_type}/${r.osm_id}`;
  const lat = +r.lat, lng = +r.lon;
  map.setView([lat, lng], 17);
  const existing = bakeries.find((b) => b.osmId === osmId);
  if (existing) { openSheet(existing.id); return; }
  clearTemp();
  tempMarker = L.marker([lat, lng], { icon: pinIcon('temp') }).addTo(map);
  openAddDialog({
    lat, lng, osmId,
    name: r.name || r.display_name.split(',')[0],
    address: shortAddress(r.address),
    openingHours: r.extratags?.opening_hours || '',
  });
}

/* ---------- "Add a bakery" pop-up ---------- */

const addDialog = $('#add-dialog');
const addForm = $('#add-form');

function openAddDialog(place) {
  pendingPlace = place;
  addForm.reset();
  addForm.elements.name.value = place.name;
  addForm.elements.address.value = place.address;
  addDialog.showModal();
  if (!place.name) addForm.elements.name.focus();
}

function addBakery(place, status) {
  const b = {
    id: uid(),
    name: place.name,
    address: place.address,
    lat: place.lat,
    lng: place.lng,
    osmId: place.osmId,
    openingHours: place.openingHours,
    status,
    wantToTry: [],
    items: [],
    createdAt: Date.now(),
    visitedAt: status === 'visited' ? Date.now() : null,
  };
  if (status === 'visited') b.items.push(newItem());
  bakeries.push(b);
  save();
  clearTemp();
  drawMarker(b);
  openSheet(b.id, { focusNew: true });
}

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const place = {
    ...pendingPlace,
    name: addForm.elements.name.value.trim(),
    address: addForm.elements.address.value.trim(),
  };
  addDialog.close();
  addBakery(place, addForm.elements.status.value);
});

$('#add-cancel').addEventListener('click', () => addDialog.close());
addDialog.addEventListener('close', () => { clearTemp(); pendingPlace = null; });

const newItem = (name = '') => ({ id: uid(), name, rating: '', notes: '' });

/* ---------- Opening hours ---------- */

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

// Turns OpenStreetMap hours like "Mo-Fr 07:00-18:00; Sa,Su 08:00-16:00"
// into one entry per day (Monday first). Each entry is 'closed', undefined
// (not listed), or a list of [opens, closes] in minutes after midnight.
// Returns null if the format is too unusual to understand.
function parseHours(s) {
  s = s.trim();
  if (s === '24/7') return Array(7).fill([[0, 1440]]);
  const out = Array(7).fill(undefined);
  for (let rule of s.split(';')) {
    rule = rule.trim();
    if (!rule || /^PH\b/.test(rule)) continue; // skip public-holiday rules
    const m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)?\s*(.*)$/);
    if (!m) return null;
    const days = m[1] ? expandDays(m[1]) : [0, 1, 2, 3, 4, 5, 6];
    const times = m[2].trim();
    let value;
    if (/^(off|closed)$/i.test(times)) value = 'closed';
    else if (/^\d{1,2}:\d{2}-\d{1,2}:\d{2}(\s*,\s*\d{1,2}:\d{2}-\d{1,2}:\d{2})*$/.test(times)) {
      value = times.split(',').map((t) => t.trim().split('-').map(toMinutes));
    } else return null;
    days.forEach((d) => { out[d] = value; });
  }
  return out;
}
function expandDays(spec) {
  const days = [];
  for (const part of spec.split(',').filter(Boolean)) {
    const [a, b] = part.split('-').map((d) => DAYS.indexOf(d));
    if (b === undefined) { days.push(a); continue; }
    for (let d = a; ; d = (d + 1) % 7) { days.push(d); if (d === b) break; }
  }
  return days;
}
const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
function fmtTime(min) {
  min %= 1440;
  const h = Math.floor(min / 60), m = min % 60;
  const suffix = h >= 12 ? 'pm' : 'am';
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${suffix}`;
}
const fmtRanges = (ranges) => ranges.map(([a, z]) =>
  (a === 0 && z === 1440) ? 'open 24 hours' : `${fmtTime(a)}–${fmtTime(z)}`).join(', ');

const todayIndex = () => (new Date().getDay() + 6) % 7; // JS weeks start on Sunday

function hoursToday(b) {
  if (!b.openingHours) return null;
  const parsed = parseHours(b.openingHours);
  if (!parsed) return `Hours: ${b.openingHours}`;
  const today = parsed[todayIndex()];
  if (today === undefined) return 'Hours not listed for today';
  if (today === 'closed') return 'Closed today';
  return `Today: ${fmtRanges(today)}`;
}

// Is it open right now? state is 'open', 'closed' or 'unknown'.
function openStatus(b) {
  const parsed = b.openingHours && parseHours(b.openingHours);
  const today = parsed?.[todayIndex()];
  if (!parsed || today === undefined) {
    return { state: 'unknown', text: b.openingHours ? hoursToday(b) : 'Hours unknown' };
  }
  if (today === 'closed') return { state: 'closed', text: 'Closed today' };
  const now = new Date().getHours() * 60 + new Date().getMinutes();
  for (const [a, z] of today) {
    const end = z <= a ? z + 1440 : z; // handles hours that run past midnight
    if (now >= a && now < end) {
      return { state: 'open', text: end >= 1440 && a === 0 ? 'Open 24 hours' : `Open now · until ${fmtTime(z)}` };
    }
  }
  const later = today.find(([a]) => a > now);
  return { state: 'closed', text: later ? `Closed now · opens ${fmtTime(later[0])}` : 'Closed for the day' };
}

/* ---------- Bakery info panel ---------- */

const sheet = $('#sheet');
const sheetBody = $('#sheet-body');

let openedByRandom = false; // shows a "Pick another" button in the panel

function openSheet(id, { focusNew = false, fromRandom = false } = {}) {
  openedByRandom = fromRandom;
  if (discoveredPlace) { discoveredPlace = null; clearTemp(); }
  const prev = openId;
  openId = id;
  if (prev && getBakery(prev)) drawMarker(getBakery(prev));
  const b = getBakery(id);
  drawMarker(b);
  renderSheet();
  sheet.hidden = false;
  sheet.scrollTop = 0;
  panAboveSheet(b.lat, b.lng);
  if (focusNew) focusLatest();
}

// Slide the map so a pin sits in the visible area above the panel.
function panAboveSheet(lat, lng) {
  const p = map.project([lat, lng]).add([0, sheet.offsetHeight / 2]);
  map.panTo(map.unproject(p));
}

function closeSheet() {
  sheet.hidden = true;
  if (discoveredPlace) { discoveredPlace = null; clearTemp(); }
  if (!openId) return;
  const id = openId;
  openId = null;
  if (getBakery(id)) drawMarker(getBakery(id));
}
$('#sheet-close').addEventListener('click', closeSheet);

function focusLatest() {
  const b = getBakery(openId);
  const el = b.status === 'visited'
    ? [...sheetBody.querySelectorAll('.item-name')].pop()
    : sheetBody.querySelector('#try-input');
  el?.focus();
}

function renderSheet() {
  const b = getBakery(openId);
  if (!b) return;
  const hours = hoursToday(b);
  let html = `
    ${openedByRandom ? '<button type="button" class="reroll" data-action="reroll">🎲 Pick another</button>' : ''}
    <input class="title-input" data-field="name" value="${esc(b.name)}" aria-label="Bakery name">
    ${b.address ? `<p class="meta">📍 ${esc(b.address)}</p>` : ''}
    ${hours ? `<p class="meta hours">🕒 ${esc(hours)}</p>` : ''}
    <div class="status-toggle">
      <button type="button" data-action="status" data-status="want" class="want ${b.status === 'want' ? 'on' : ''}">★ Want to visit</button>
      <button type="button" data-action="status" data-status="visited" class="visited ${b.status === 'visited' ? 'on' : ''}">✓ Visited</button>
    </div>`;

  if (b.status === 'want') {
    html += `
      <h3 class="section-title">Things I want to try</h3>
      <p class="prompt">Is there anything specific you want to try here?</p>
      <ul class="try-list">
        ${b.wantToTry.map((t) => `<li><span>${esc(t.text)}</span>
          <button type="button" class="x-btn" data-action="del-try" data-id="${t.id}" aria-label="Remove">×</button></li>`).join('')}
      </ul>
      <form class="add-row" id="try-form">
        <input id="try-input" placeholder="e.g. Pistachio croissant" enterkeyhint="done">
        <button type="submit" class="primary">Add</button>
      </form>`;
  } else {
    html += `
      <h3 class="section-title">What I got</h3>
      <p class="prompt">Add each item you tried, give it a grade, and jot down any notes.</p>
      ${b.wantToTry.length ? `
        <p class="prompt">From your to-try list (tap to add):</p>
        <div class="chips">${b.wantToTry.map((t) =>
          `<button type="button" class="chip-btn" data-action="try-to-item" data-id="${t.id}">+ ${esc(t.text)}</button>`).join('')}</div>` : ''}
      ${b.items.map((it) => `
        <div class="item" data-item="${it.id}">
          <div class="item-top">
            <input class="item-name" data-field="item-name" value="${esc(it.name)}" placeholder="What did you get?">
            <button type="button" class="x-btn" data-action="del-item" aria-label="Delete item">×</button>
          </div>
          <div class="ratings">
            ${RATINGS.map((r) => `<button type="button" data-action="rate" data-r="${r}" class="r-${r} ${it.rating === r ? 'on' : ''}">${r}</button>`).join('')}
          </div>
          <textarea data-field="item-notes" rows="2" placeholder="Notes (taste, texture, price, would you get it again?)">${esc(it.notes)}</textarea>
        </div>`).join('')}
      <button type="button" class="add-item" data-action="add-item">+ Add another item</button>`;
  }

  html += `<button type="button" class="danger" data-action="delete-bakery">Remove this bakery</button>`;
  sheetBody.innerHTML = html;
}

// Typing in a box saves straight away (no re-draw, so the keyboard stays open).
sheetBody.addEventListener('input', (e) => {
  const b = getBakery(openId);
  const field = e.target.dataset.field;
  if (!b || !field) return;
  if (field === 'name') {
    b.name = e.target.value;
  } else {
    const it = b.items.find((i) => i.id === e.target.closest('.item').dataset.item);
    if (field === 'item-name') it.name = e.target.value;
    if (field === 'item-notes') it.notes = e.target.value;
  }
  save();
});

sheetBody.addEventListener('submit', (e) => {
  if (e.target.id !== 'try-form') return;
  e.preventDefault();
  const input = $('#try-input');
  const text = input.value.trim();
  if (!text) return;
  getBakery(openId).wantToTry.push({ id: uid(), text });
  save();
  renderSheet();
  $('#try-input').focus();
});

sheetBody.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'reroll') { runRandom(); return; }
  if (btn.dataset.action === 'add-discovered') {
    const place = discoveredPlace;
    discoveredPlace = null;
    addBakery(place, btn.dataset.status);
    return;
  }
  if (btn.dataset.action === 'open-bakery') { // a card in the "Near me" panel
    const target = getBakery(btn.dataset.id);
    map.setView([target.lat, target.lng], 16);
    openSheet(target.id);
    return;
  }
  const b = getBakery(openId);
  const itemEl = btn.closest('.item');
  const item = itemEl && b.items.find((i) => i.id === itemEl.dataset.item);

  switch (btn.dataset.action) {
    case 'status':
      if (b.status === btn.dataset.status) return;
      b.status = btn.dataset.status;
      if (b.status === 'visited') {
        b.visitedAt = b.visitedAt || Date.now();
        if (!b.items.length && !b.wantToTry.length) b.items.push(newItem());
      }
      save();
      drawMarker(b);
      renderSheet();
      return;
    case 'del-try':
      b.wantToTry = b.wantToTry.filter((t) => t.id !== btn.dataset.id);
      break;
    case 'try-to-item': {
      const t = b.wantToTry.find((x) => x.id === btn.dataset.id);
      b.wantToTry = b.wantToTry.filter((x) => x !== t);
      b.items.push(newItem(t.text));
      break;
    }
    case 'add-item':
      b.items.push(newItem());
      save();
      renderSheet();
      focusLatest();
      return;
    case 'del-item':
      if ((item.name || item.notes) && !confirm(`Delete “${item.name || 'this item'}”?`)) return;
      b.items = b.items.filter((i) => i !== item);
      break;
    case 'rate':
      item.rating = item.rating === btn.dataset.r ? '' : btn.dataset.r; // tap again to clear
      break;
    case 'delete-bakery':
      if (!confirm(`Remove ${b.name || 'this bakery'} and all its notes?`)) return;
      bakeries = bakeries.filter((x) => x !== b);
      map.removeLayer(markers[b.id]);
      delete markers[b.id];
      openId = null;
      sheet.hidden = true;
      save();
      return;
  }
  save();
  renderSheet();
});

/* ---------- List tab ---------- */

const GRADE_SCORE = { S: 5, A: 4, B: 3, C: 2, D: 1, F: 0 };
const gradeScore = (r) => GRADE_SCORE[r] ?? -1; // ungraded sorts last
const byBestGrade = (x, y) => gradeScore(y.rating) - gradeScore(x.rating);

function averageScore(b) {
  const rated = b.items.filter((i) => i.rating);
  if (!rated.length) return null;
  return rated.reduce((sum, i) => sum + GRADE_SCORE[i.rating], 0) / rated.length;
}

const SORTS = {
  want: [['recent', 'Newest'], ['open', 'Open now'], ['near', 'Nearest']],
  visited: [['recent', 'Recent'], ['rating', 'Top rated'], ['name', 'A–Z']],
};
const OPEN_ORDER = { open: 0, unknown: 1, closed: 2 };

let listFilter = 'want';
const searches = { want: '', visited: '', items: '' }; // each view keeps its own search
const SEARCH_HINTS = {
  want: 'Search bakeries or things to try',
  visited: 'Search bakeries, items or notes',
  items: 'Search items, e.g. croissant',
};

// Does this bakery mention the search words anywhere you've written about it?
function bakeryMatches(b, q) {
  const text = [b.name, b.address, ...b.wantToTry.map((t) => t.text),
    ...b.items.flatMap((i) => [i.name, i.notes])].join(' ').toLowerCase();
  return text.includes(q);
}
let sortBy = { want: 'recent', visited: 'recent' };
try { sortBy = { ...sortBy, ...JSON.parse(localStorage.getItem('bakery-log-sort')) }; } catch {}

function setSort(key) {
  sortBy[listFilter] = key;
  try { localStorage.setItem('bakery-log-sort', JSON.stringify(sortBy)); } catch {}
  if (key === 'near' && !myPos) whenLocated(renderList);
  renderList();
}

function renderList() {
  const want = bakeries.filter((b) => b.status === 'want');
  const visited = bakeries.filter((b) => b.status === 'visited');
  const allItems = bakeries.flatMap((b) => b.items.filter((i) => i.name.trim()).map((i) => ({ i, b })));
  $('#count-want').textContent = want.length;
  $('#count-visited').textContent = visited.length;
  $('#count-items').textContent = allItems.length;

  const search = $('#list-search');
  search.placeholder = SEARCH_HINTS[listFilter];
  if (search.value !== searches[listFilter]) search.value = searches[listFilter];
  const q = searches[listFilter].trim().toLowerCase();

  // Sort buttons (the Items view is always sorted by grade)
  const sorts = SORTS[listFilter];
  $('#sort-bar').hidden = !sorts;
  if (sorts) {
    $('#sort-bar').innerHTML = '<span class="muted">Sort:</span>' + sorts.map(([key, label]) =>
      `<button type="button" data-sort="${key}" class="${sortBy[listFilter] === key ? 'on' : ''}">${label}</button>`).join('');
  }

  if (listFilter === 'items') { renderItems(allItems, q); return; }

  const all = listFilter === 'want' ? want : visited;
  if (!all.length) {
    $('#list').innerHTML = `<p class="empty">${listFilter === 'want'
      ? 'No bakeries on your wish list yet.<br>Go to the Map tab to search for one or drop a pin.'
      : 'You haven’t logged any visits yet.<br>Open a bakery and mark it “Visited” to start.'}</p>`;
    return;
  }
  const shown = q ? all.filter((b) => bakeryMatches(b, q)) : all;
  if (!shown.length) {
    $('#list').innerHTML = `<p class="empty">Nothing matches “${esc(q)}”.</p>`;
    return;
  }

  const sort = sortBy[listFilter];
  const dist = (b) => myPos ? distanceKm(myPos, [b.lat, b.lng]) : null;
  const byName = (x, y) => (x.name || '').localeCompare(y.name || '');
  let note = '';
  if (listFilter === 'want') {
    shown.sort((x, y) => y.createdAt - x.createdAt);
    if (sort === 'open') shown.sort((x, y) => OPEN_ORDER[openStatus(x).state] - OPEN_ORDER[openStatus(y).state]);
    if (sort === 'near') {
      if (myPos) shown.sort((x, y) => dist(x) - dist(y));
      else note = '<p class="prompt">Finding your location…</p>';
    }
  } else {
    shown.sort((x, y) => y.visitedAt - x.visitedAt);
    if (sort === 'rating') shown.sort((x, y) => (averageScore(y) ?? -1) - (averageScore(x) ?? -1));
    if (sort === 'name') shown.sort(byName);
  }

  $('#list').innerHTML = note + shown.map((b) => {
    let side = '', body = '';
    if (b.status === 'want') {
      if (myPos) side = `<span class="dist">${fmtDistance(dist(b))}</span>`;
      const status = openStatus(b);
      if (b.openingHours) body += `<p class="meta hours"><span class="dot ${status.state}"></span>${esc(status.text)}</p>`;
      if (b.wantToTry.length) body += `<p class="sub">Want to try</p><ul>${b.wantToTry.map((t) => `<li>${esc(t.text)}</li>`).join('')}</ul>`;
    } else {
      const avg = averageScore(b);
      if (avg !== null) side = `<span class="avg">avg <span class="badge r-${RATINGS[Math.round(avg)]}">${RATINGS[Math.round(avg)]}</span></span>`;
      const named = b.items.filter((i) => i.name.trim()).sort(byBestGrade);
      if (named.length) body += `<p class="sub">Tried</p><ul class="tried">${named.map((i) =>
        `<li><span class="badge ${i.rating ? 'r-' + i.rating : ''}">${i.rating || '–'}</span>${esc(i.name)}</li>`).join('')}</ul>`;
    }
    return `<div class="card" data-id="${b.id}">
      <div class="near-top"><h3>${esc(b.name || 'Unnamed bakery')}</h3>${side}</div>
      ${b.address ? `<p class="meta">📍 ${esc(b.address)}</p>` : ''}
      ${body}
    </div>`;
  }).join('');
}

// Every item you've tried, grouped into S/A/B/C/D/F tiers.
function renderItems(allItems, q) {
  if (!allItems.length) {
    $('#list').innerHTML = '<p class="empty">Items you add at bakeries you’ve visited will show up here, ranked from S down to F.</p>';
    return;
  }
  const shown = q
    ? allItems.filter(({ i }) => i.name.toLowerCase().includes(q))
    : allItems;
  if (!shown.length) {
    $('#list').innerHTML = `<p class="empty">Nothing matches “${esc(q)}”.</p>`;
    return;
  }
  const tiers = [...RATINGS].reverse().concat('');
  $('#list').innerHTML = tiers.map((grade) => {
    const rows = shown.filter(({ i }) => (i.rating || '') === grade)
      .sort((x, y) => x.i.name.localeCompare(y.i.name));
    if (!rows.length) return '';
    return `<div class="tier">
      <h3 class="tier-head">${grade ? `<span class="badge r-${grade}">${grade}</span> tier` : 'Not graded yet'}
        <span class="muted">${rows.length}</span></h3>
      ${rows.map(({ i, b }) => `
        <div class="item-row" data-id="${b.id}">
          <div class="item-row-name">${esc(i.name)}</div>
          <div class="item-row-bakery">${esc(b.name || 'Unnamed bakery')}</div>
          ${i.notes.trim() ? `<div class="item-row-notes">${esc(i.notes)}</div>` : ''}
        </div>`).join('')}
    </div>`;
  }).join('');
}

$('#list').addEventListener('click', (e) => {
  const card = e.target.closest('[data-id]');
  if (!card) return;
  const b = getBakery(card.dataset.id);
  showTab('map-view');
  map.setView([b.lat, b.lng], 16);
  openSheet(b.id);
});

$('#list-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  listFilter = btn.dataset.filter;
  document.querySelectorAll('#list-filter button').forEach((x) => x.classList.toggle('on', x === btn));
  if (listFilter === 'want' && sortBy.want === 'near' && !myPos) whenLocated(renderList);
  renderList();
});

$('#sort-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-sort]');
  if (btn) setSort(btn.dataset.sort);
});

$('#list-search').addEventListener('input', (e) => {
  searches[listFilter] = e.target.value;
  renderList();
});

/* ---------- Tabs ---------- */

function showTab(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  document.querySelectorAll('.tabbar button').forEach((t) => t.classList.toggle('on', t.dataset.tab === id));
  if (id === 'map-view') map.invalidateSize();
  else { closeSheet(); stopPlacing(); }
}
document.querySelector('.tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) showTab(btn.dataset.tab);
});

/* ---------- Backup ---------- */

const menuDialog = $('#menu-dialog');
$('#menu-btn').addEventListener('click', () => menuDialog.showModal());
$('#menu-close').addEventListener('click', () => menuDialog.close());

$('#export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(bakeries, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bakery-log-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error();
    if (!confirm(`Replace your current ${bakeries.length} bakeries with the ${data.length} in this backup?`)) return;
    Object.values(markers).forEach((m) => map.removeLayer(m));
    Object.keys(markers).forEach((k) => delete markers[k]);
    bakeries = data;
    save();
    bakeries.forEach(drawMarker);
    menuDialog.close();
  } catch {
    alert('That file doesn’t look like a Bakery Log backup.');
  }
});

/* ---------- Start up ---------- */

bakeries.forEach(drawMarker);
renderList();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
