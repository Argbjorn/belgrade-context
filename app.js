import { loadConfig, initSync, signIn, signOut, watchMarks, setMark, mergeMarks } from './sync.js';

const DATA_URL = 'data/zhenya_v_belgrade.geojson';
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const BELGRADE = [20.4573, 44.8125];

const KEYS = {
  visited: 'bvm:visited',
  favorites: 'bvm:favorites',
  hideVisited: 'bvm:hideVisited',
  onlyFavorites: 'bvm:onlyFavorites',
  // uid of the account whose marks are cached in localStorage; null = marks made without signing in
  uid: 'bvm:uid',
};

// localStorage can throw (private mode, blocked storage) — the map must work anyway
const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

const visited = new Set(store.get(KEYS.visited, []));
const favorites = new Set(store.get(KEYS.favorites, []));
const marks = { visited, favorites };
const filters = {
  hideVisited: store.get(KEYS.hideVisited, false),
  onlyFavorites: store.get(KEYS.onlyFavorites, false),
};

// Ask the browser not to evict our storage (helps against Safari's 7-day purge)
navigator.storage?.persist?.();

const isMobile = () => matchMedia('(max-width: 640px)').matches;

let features = [];
const byId = new Map();

// ---------- Map ----------

const map = new maplibregl.Map({
  container: 'map',
  style: STYLE_URL,
  center: BELGRADE,
  zoom: 12,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
// Android Chrome drops the WebGL context of a backgrounded tab. MapLibre 4 recreates the painter on restore,
// but tiles and style atlases keep GPU objects from the dead context and the map renders blank.
// Rebuilding the style from its own snapshot recreates all of them; our points and layers are part of the snapshot.
map.on('webglcontextrestored', () => {
  if (!map.isStyleLoaded()) return;
  map.setStyle(map.getStyle(), { diff: false });
});

map.addControl(new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
}), 'top-right');

class FilterControl {
  onAdd() {
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group filter-ctrl';
    this.el.innerHTML = `
      <label><input type="checkbox" data-filter="hideVisited"> Скрыть посещенное</label>
      <label><input type="checkbox" data-filter="onlyFavorites"> Избранное</label>
      <div class="filter-count"></div>`;
    this.counter = this.el.querySelector('.filter-count');
    for (const input of this.el.querySelectorAll('input')) {
      const name = input.dataset.filter;
      input.checked = filters[name];
      input.addEventListener('change', () => {
        filters[name] = input.checked;
        store.set(KEYS[name], input.checked);
        render();
      });
    }
    this.update();
    return this.el;
  }

  onRemove() {
    this.el.remove();
  }

  update() {
    const count = features.filter(f => visited.has(f.id)).length;
    this.counter.textContent = `Посещено ${count} из ${features.length}`;
  }
}

const filterControl = new FilterControl();
map.addControl(filterControl, 'top-left');

class AccountControl {
  onAdd() {
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group account-ctrl';
    this.el.innerHTML = `<span class="account-name"></span><button type="button"></button>`;
    this.name = this.el.querySelector('.account-name');
    this.button = this.el.querySelector('button');
    this.button.addEventListener('click', () => {
      const action = user ? signOut() : signIn();
      action.catch(err => {
        if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
        console.error(err);
        alert(`Не удалось ${user ? 'выйти' : 'войти'}: ${err.message}`);
      });
    });
    this.update();
    return this.el;
  }

  onRemove() {
    this.el.remove();
  }

  update() {
    this.name.textContent = user ? (user.displayName || user.email) : '';
    this.name.hidden = !user;
    this.button.textContent = user ? 'Выйти' : 'Войти через Google';
    this.button.title = user ? '' : 'Чтобы отметки синхронизировались между устройствами';
  }
}

// ---------- Sync (Firebase) ----------

let user = null;
let unwatch = null;
const accountControl = new AccountControl();

loadConfig()
  .then(ok => {
    if (!ok) return;
    map.addControl(accountControl, 'top-left');
    return initSync(handleAuth);
  })
  .catch(err => console.error('Firebase не загрузился, работаем на localStorage', err));

function handleAuth(nextUser) {
  unwatch?.();
  unwatch = null;
  user = nextUser;
  accountControl.update();

  if (!user) {
    // Signed out: cached marks belonged to the account, don't leave them on the device
    if (store.get(KEYS.uid, null)) {
      store.set(KEYS.uid, null);
      applyMarks({ visited: [], favorites: [] });
    }
    return;
  }

  if (store.get(KEYS.uid, null) !== user.uid) {
    // First sign-in on this device: marks made before it go into the account
    mergeMarks(user.uid, { visited: [...visited], favorites: [...favorites] }).catch(console.error);
    store.set(KEYS.uid, user.uid);
  }
  unwatch = watchMarks(user.uid, applyMarks);
}

function applyMarks(data) {
  for (const field of ['visited', 'favorites']) {
    marks[field].clear();
    data[field].forEach(id => marks[field].add(id));
    store.set(KEYS[field], data[field]);
  }
  render();
  if (openCardId) updateButtons(openCardEl, openCardId);
}

function render() {
  if (!map.getSource('points')) return;
  const shown = features.filter(f =>
    !(filters.hideVisited && visited.has(f.id)) &&
    !(filters.onlyFavorites && !favorites.has(f.id)));
  map.getSource('points').setData({
    type: 'FeatureCollection',
    features: shown.map(f => ({
      ...f,
      properties: {
        ...f.properties,
        id: f.id,
        visited: visited.has(f.id),
        favorite: favorites.has(f.id),
      },
    })),
  });
  filterControl.update();
}

map.on('load', async () => {
  const data = await fetch(DATA_URL).then(r => r.json());
  features = data.features;
  features.forEach(f => byId.set(f.id, f));

  map.addSource('points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  map.addLayer({
    id: 'points',
    type: 'circle',
    source: 'points',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 9],
      'circle-color': ['case', ['get', 'visited'], '#2f9e44', '#e5484d'],
      'circle-stroke-width': ['case', ['get', 'favorite'], 3, 2],
      'circle-stroke-color': ['case', ['get', 'favorite'], '#f5b301', '#ffffff'],
    },
  });

  // Same point drawn on top in a darker shade while its card is open; filter is switched in selectPoint()
  map.addLayer({
    id: 'points-selected',
    type: 'circle',
    source: 'points',
    filter: ['==', ['get', 'id'], ''],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 9],
      'circle-color': ['case', ['get', 'visited'], '#1b5e20', '#a4161a'],
      'circle-stroke-width': ['case', ['get', 'favorite'], 3, 2],
      'circle-stroke-color': ['case', ['get', 'favorite'], '#f5b301', '#ffffff'],
    },
  });

  map.addLayer({
    id: 'points-label',
    type: 'symbol',
    source: 'points',
    minzoom: 14,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
      'text-max-width': 10,
      'text-optional': true,
    },
    paint: {
      'text-color': '#1c1c1e',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.5,
    },
  });

  // Invisible, larger circles so points are easy to tap with a finger
  map.addLayer({
    id: 'points-hit',
    type: 'circle',
    source: 'points',
    paint: { 'circle-radius': 18, 'circle-opacity': 0 },
  });

  render();
});

map.on('click', 'points-hit', e => {
  const f = e.features[0];
  openCard(f.properties.id, f.geometry.coordinates);
});

map.on('click', e => {
  if (!map.queryRenderedFeatures(e.point, { layers: ['points-hit'] }).length) closeCard();
});

map.on('mouseenter', 'points-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'points-hit', () => { map.getCanvas().style.cursor = ''; });

// ---------- Card (popup on desktop, bottom sheet on mobile) ----------

const sheet = document.getElementById('sheet');
const sheetBody = sheet.querySelector('.sheet-body');
let popup = null;

sheet.querySelector('.sheet-close').addEventListener('click', closeCard);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeCard();
});

function linkLabel(url) {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function buildCard(id) {
  const f = byId.get(id);
  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('h3');
  title.textContent = f.properties.name;
  card.append(title);

  const links = (f.properties.description || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (links.length) {
    const list = document.createElement('ul');
    list.className = 'links';
    for (const url of links) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = linkLabel(url);
      const li = document.createElement('li');
      li.append(a);
      list.append(li);
    }
    card.append(list);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.innerHTML = `
    <button type="button" data-act="visited"></button>
    <button type="button" data-act="favorite">
      <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linejoin="round">
        <path d="M12 2.8l2.85 5.78 6.38.93-4.62 4.5 1.09 6.35L12 17.36l-5.7 3 1.09-6.35-4.62-4.5 6.38-.93z"/>
      </svg>
    </button>`;
  actions.addEventListener('click', e => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'visited') toggle('visited', id);
    if (act === 'favorite') toggle('favorites', id);
    updateButtons(card, id);
  });
  card.append(actions);

  updateButtons(card, id);
  return card;
}

function updateButtons(card, id) {
  const v = card.querySelector('[data-act="visited"]');
  const fav = card.querySelector('[data-act="favorite"]');
  v.setAttribute('aria-pressed', visited.has(id));
  v.textContent = visited.has(id) ? '✓ Посещено' : 'Отметить посещённым';
  fav.setAttribute('aria-pressed', favorites.has(id));
  fav.setAttribute('aria-label', favorites.has(id) ? 'Убрать из избранного' : 'В избранное');
  fav.title = fav.getAttribute('aria-label');
}

function toggle(field, id) {
  const set = marks[field];
  set.has(id) ? set.delete(id) : set.add(id);
  store.set(KEYS[field], [...set]);
  render();
  if (user) setMark(user.uid, field, id, set.has(id)).catch(console.error);
}

let openCardId = null;
let openCardEl = null;

function openCard(id, coordinates) {
  closeCard();
  selectPoint(id);
  const card = buildCard(id);
  openCardId = id;
  openCardEl = card;

  if (isMobile()) {
    sheetBody.append(card);
    sheet.hidden = false;
    // Keep the point visible in the upper half, above the sheet
    map.easeTo({ center: coordinates, offset: [0, -window.innerHeight / 4] });
  } else {
    popup = new maplibregl.Popup({ offset: 12, maxWidth: '300px', closeOnClick: false })
      .setLngLat(coordinates)
      .setDOMContent(card)
      .addTo(map);
    // The popup has its own close button
    popup.on('close', () => selectPoint(null));
  }
}

function selectPoint(id) {
  if (!map.getLayer('points-selected')) return;
  map.setFilter('points-selected', ['==', ['get', 'id'], id ?? '']);
}

function closeCard() {
  popup?.remove();
  popup = null;
  openCardId = null;
  openCardEl = null;
  selectPoint(null);
  sheet.hidden = true;
  sheetBody.replaceChildren();
}
