/**
 * Hyper-Local Heatwave Early Warning & HTSI Platform
 * Leaflet GIS Engine: Satellite-Hybrid + Dark Command Tiles, Ward Polygons & Dynamic Thermal Heatmaps
 */

let mapInstance = null;
let geoLayers = {};
let currentlySelectedWardId = null;
let userLocationMarker = null;
let userAccuracyRing = null;
let userHaloDot = null;
let userOuterGlow = null;
let baseLayerControl = null;

// Base tile layers (Free, zero API key, no watermark)
const SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const SATELLITE_LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const DARK_CANVAS_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';

/**
 * Initializes the Leaflet map with Satellite-Hybrid default + Dark Command Center toggle.
 * Satellite imagery (0-19) grouped with international/state borders & city labels overlay.
 */
function initMap() {
  if (mapInstance !== null) {
    mapInstance.invalidateSize();
    return;
  }

  // Base Layers
  const satelliteBase = L.tileLayer(SATELLITE_TILES, {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
  });

  const boundariesAndLabels = L.tileLayer(SATELLITE_LABELS, {
    maxZoom: 19,
    attribution: 'Labels &copy; Esri'
  });

  const darkCanvas = L.tileLayer(DARK_CANVAS_TILES, {
    maxZoom: 18,
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ'
  });

  // Group satellite imagery with international and city boundary labels
  const satelliteHybrid = L.layerGroup([satelliteBase, boundariesAndLabels]);

  // Initialize Map: allow zooming out to see countries (minZoom: 2) up to building-level (maxZoom: 18)
  mapInstance = L.map('map', {
    center: [22.7196, 75.8577], // Initial live center (Indore); auto-GPS corrects on load
    zoom: 12,
    minZoom: 2,                 // Allows zooming out to whole world
    maxZoom: 19,
    zoomControl: true,
    worldCopyJump: true,
    layers: [satelliteHybrid]   // Default to Satellite View
  });

  // Layer control switcher at top-right
  const baseMaps = {
    "🛰️ Satellite (Hybrid Borders)": satelliteHybrid,
    "🏙️ Dark Command Center": darkCanvas
  };

  baseLayerControl = L.control.layers(baseMaps, null, { position: 'topright' }).addTo(mapInstance);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(mapInstance);

  // Responsive redraw on container resize
  window.addEventListener('resize', () => {
    if (mapInstance) mapInstance.invalidateSize();
  });
}

/**
 * Renders all municipal ward polygons with high-contrast satellite styling,
 * interactive tooltips and selection handlers. Accepts the legacy array form
 * [{id,name,zone,population,coords}] and GeoJSON FeatureCollections.
 */
function renderWardsOnMap(wardsOrGeoJSON, onWardClick) {
  const wards = normalizeWardsInput(wardsOrGeoJSON);
  // Clear any existing layers
  Object.values(geoLayers).forEach(item => {
    if (item.polygon && mapInstance.hasLayer(item.polygon)) {
      mapInstance.removeLayer(item.polygon);
    }
  });
  geoLayers = {};

  const bounds = [];

  wards.forEach(ward => {
    const polygon = L.polygon(ward.coords, {
      color: "#38bdf8",          // Neon cyan contour line
      weight: 2.5,
      dashArray: "4, 4",
      opacity: 1.0,
      fillColor: "#22c55e",       // Semi-translucent risk fill
      fillOpacity: 0.45,          // Keeps terrain & satellite roads visible underneath
      className: `ward-poly-${ward.id}`
    }).addTo(mapInstance);

    // Initial Tooltip (hover): Ward Name + Zone + formatted population
    const tooltipContent = `
      <div class="map-tip-inner">
        <strong class="map-tip-title">${ward.name} (${ward.id})</strong><br/>
        <span class="map-tip-zone">${ward.zone || "Municipal Ward"}</span><br/>
        <span>Pop: ${Number(ward.population).toLocaleString("en-IN")}</span>
      </div>
    `;
    polygon.bindTooltip(tooltipContent, { sticky: true, direction: "top", className: "map-custom-tooltip" });

    // Interaction Events (high-contrast hover over satellite)
    polygon.on('mouseover', function () {
      if (currentlySelectedWardId !== ward.id) {
        this.setStyle({
          weight: 3.5,
          color: "#ffffff",
          fillOpacity: 0.70
        });
        this.bringToFront();
      }
    });

    polygon.on('mouseout', function () {
      if (currentlySelectedWardId !== ward.id) {
        this.setStyle({
          weight: 2.5,
          color: "#38bdf8",
          dashArray: "4, 4",
          fillOpacity: 0.45
        });
      }
    });

    polygon.on('click', () => {
      highlightWardPolygon(ward.id);
      onWardClick(ward);
    });

    geoLayers[ward.id] = { polygon, data: ward };
    bounds.push(...ward.coords);
  });

  // Fit bounds if valid coordinates exist
  if (bounds.length > 0) {
    mapInstance.fitBounds(L.latLngBounds(bounds), { padding: [30, 30] });
  }
}

/**
 * Normalizes ward input: legacy [{...coords}] arrays pass through, while
 * GeoJSON FeatureCollections are converted to the same internal shape.
 */
function normalizeWardsInput(input) {
  if (Array.isArray(input)) return input;
  if (input && input.type === "FeatureCollection" && Array.isArray(input.features)) {
    return input.features.map((f, i) => {
      const p = (f && f.properties) || {};
      let coords = [];
      try {
        const g = f.geometry || {};
        if (g.type === "Polygon" && Array.isArray(g.coordinates) && g.coordinates[0]) {
          coords = g.coordinates[0].map(pt => [pt[1], pt[0]]);
        } else if (g.type === "MultiPolygon" && g.coordinates && g.coordinates[0] && g.coordinates[0][0]) {
          coords = g.coordinates[0][0].map(pt => [pt[1], pt[0]]);
        }
      } catch (e) { coords = []; }
      return {
        id: p.id || `W0${i + 1}`,
        name: p.name || `Ward ${i + 1}`,
        zone: p.zone || "Municipal Ward",
        population: p.population || 100000,
        elderly_pct: p.elderly_pct !== undefined ? p.elderly_pct : 10,
        outdoor_worker_pct: p.outdoor_worker_pct !== undefined ? p.outdoor_worker_pct : 25,
        ndvi: p.ndvi !== undefined ? p.ndvi : 0.3,
        coords: coords
      };
    }).filter(w => w.coords.length > 0);
  }
  return [];
}

/**
 * Updates polygon fill colors and dynamic tooltips based on current forecast timestep
 */
function updateMapColors(timelineEntry) {
  if (!timelineEntry || !timelineEntry.wards) return;

  Object.keys(geoLayers).forEach(wardId => {
    const wardRisk = timelineEntry.wards[wardId];
    const layerItem = geoLayers[wardId];

    if (wardRisk && layerItem && layerItem.polygon) {
      const isSelected = currentlySelectedWardId === wardId;
      layerItem.polygon.setStyle({
        fillColor: wardRisk.color,
        fillOpacity: isSelected ? 0.70 : 0.45,
        color: isSelected ? "#ffffff" : "#38bdf8",
        weight: isSelected ? 3.5 : 2.5,
        dashArray: isSelected ? null : "4, 4"
      });

      // Update Tooltip to show real-time thermal load
      const ward = layerItem.data;
      const updatedTooltip = `
        <div style="font-family: sans-serif; font-size: 12px; line-height: 1.4;">
          <strong style="color: #38bdf8;">${ward.name} (${ward.id})</strong><br/>
          <span style="color: ${wardRisk.color}; font-weight: bold;">HTSI: ${wardRisk.adjusted_htsi} &bull; ${wardRisk.band}</span><br/>
          <span>Projected Surges: +${wardRisk.projected_cases} ER/day</span><br/>
          <small style="color: #94a3b8;">Pop: ${ward.population.toLocaleString()} | Labor: ${ward.outdoor_worker_pct}%</small>
        </div>
      `;
      layerItem.polygon.setTooltipContent(updatedTooltip);
    }
  });
}

/**
 * Highlights a specific ward's polygon border
 */
function highlightWardPolygon(wardId) {
  currentlySelectedWardId = wardId;
  Object.keys(geoLayers).forEach(id => {
    const layerItem = geoLayers[id];
    if (layerItem && layerItem.polygon) {
      if (id === wardId) {
        layerItem.polygon.setStyle({
          weight: 3.5,
          color: "#ffffff",
          dashArray: null,
          fillOpacity: 0.70
        });
        layerItem.polygon.bringToFront();
      } else {
        layerItem.polygon.setStyle({
          weight: 2.5,
          color: "#38bdf8",
          dashArray: "4, 4",
          fillOpacity: 0.45
        });
      }
    }
  });
}

/**
 * Generates 4 organic, multi-sided municipal ward polygons contouring around
 * a detected city center (no rectangular grid boxes). Mirrors the backend
 * build_wards_for_location() profiles so offline maps look identical.
 * W01 Central Commercial & Dense Core / W02 Northern Green Residential &
 * Institutional / W03 Eastern Industrial & Logistics Hub / W04 South-West
 * Urban Slum & Informal Settlement.
 */
function generateRealisticWardGeoJSON(centerLat, centerLon) {
  const lat = Number(centerLat), lon = Number(centerLon);
  const profiles = [
    { id: "W01", name: `Central Commercial & Dense Core (${lat.toFixed(2)},${lon.toFixed(2)})`, zone: "Central Core", population: 185000, elderly_pct: 14.5, outdoor_worker_pct: 44.0, ndvi: 0.11 },
    { id: "W02", name: `Northern Green Residential & Institutional (${lat.toFixed(2)},${lon.toFixed(2)})`, zone: "North Green Belt", population: 95000, elderly_pct: 9.0, outdoor_worker_pct: 14.0, ndvi: 0.58 },
    { id: "W03", name: `Eastern Industrial & Logistics Hub (${lat.toFixed(2)},${lon.toFixed(2)})`, zone: "East Industrial", population: 210000, elderly_pct: 6.5, outdoor_worker_pct: 58.0, ndvi: 0.16 },
    { id: "W04", name: `South-West Urban Slum & Informal Settlement (${lat.toFixed(2)},${lon.toFixed(2)})`, zone: "South-West Informal", population: 230000, elderly_pct: 11.2, outdoor_worker_pct: 49.0, ndvi: 0.14 }
  ];
  const anchors = [[0.018, 0.004], [-0.006, 0.030], [0.030, -0.018], [-0.026, -0.026]];
  const baseRadii = [0.030, 0.034, 0.032, 0.036];
  const seedBase = Math.abs(lat * 12.9898 + lon * 78.233);
  return profiles.map((p, idx) => {
    const cx = lat + anchors[idx][1];
    const cy = lon + anchors[idx][0];
    const r0 = baseRadii[idx];
    const seed = seedBase + idx * 37.7;
    const ring = [];
    const n = 12;
    for (let k = 0; k < n; k++) {
      const theta = (2 * Math.PI * k) / n;
      const wobble = 1.0 + 0.28 * Math.sin(2 * theta + seed) + 0.16 * Math.sin(3 * theta + seed * 1.7);
      const ex = idx === 2 ? 1.25 : (idx === 1 ? 0.9 : 1.0);
      const ey = idx === 2 ? 0.9 : (idx === 1 ? 1.2 : 1.0);
      ring.push([
        +(cx + Math.cos(theta) * r0 * wobble * ey).toFixed(5),
        +(cy + Math.sin(theta) * r0 * wobble * ex).toFixed(5)
      ]);
    }
    ring.push(ring[0].slice());
    return { ...p, coords: ring };
  });
}

/**
 * Smoothly recenters the map on the user's live device coordinates with a
 * radar-style pulse (outer glow ring + bright cyan core) that stands out on
 * textured satellite terrain. Preserves flyTo zoom 12.5 + popup behavior.
 */
function setMapToUserLocation(lat, lon, label = "Your Live Location") {
  if (!mapInstance) initMap();
  const latN = Number(lat), lonN = Number(lon);
  if (!isFinite(latN) || !isFinite(lonN)) return;

  // Smooth navigation to zoom 12.5 per spec
  try {
    mapInstance.flyTo([latN, lonN], 12.5, { duration: 1.5 });
  } catch (e) {
    mapInstance.setView([latN, lonN], 12.5);
  }

  // Remove previous user marker / ring / halo dot / glow
  clearUserLocationMarker();
  if (userLocationMarker && mapInstance.hasLayer(userLocationMarker)) {
    mapInstance.removeLayer(userLocationMarker);
    userLocationMarker = null;
  }
  if (userHaloDot && mapInstance.hasLayer(userHaloDot)) {
    mapInstance.removeLayer(userHaloDot);
    userHaloDot = null;
  }
  if (userAccuracyRing && mapInstance.hasLayer(userAccuracyRing)) {
    mapInstance.removeLayer(userAccuracyRing);
    userAccuracyRing = null;
  }

  // Accuracy halo + pulsing core marker (CSS class .user-pulse-marker)
  userAccuracyRing = L.circle([latN, lonN], {
    radius: 600,
    color: "#38bdf8",
    weight: 1.5,
    opacity: 0.6,
    fillColor: "#38bdf8",
    fillOpacity: 0.10
  }).addTo(mapInstance);

  const pulseIcon = L.divIcon({
    className: "user-pulse-wrapper",
    html: `<div class="user-pulse-marker" aria-label="user location"></div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -14]
  });

  userLocationMarker = L.marker([latN, lonN], {
    icon: pulseIcon,
    zIndexOffset: 1000,
    title: label
  }).addTo(mapInstance);

  const popupHtml = `
    <div style="font-family: sans-serif; font-size: 12px; line-height: 1.5; min-width: 190px;">
      <strong style="color: #38bdf8;">&#128205; ${label}</strong><br/>
      <span style="color: #e2e8f0;">${latN.toFixed(5)}, ${lonN.toFixed(5)}</span><br/>
      <small style="color: #94a3b8;">Live device geolocation &bull; Open-Meteo synced</small>
    </div>`;

  // Radar-style pulse: outer glow ring (satellite contrast) + accuracy halo
  userOuterGlow = L.circleMarker([latN, lonN], {
    radius: 14,
    fillColor: "#0284c7",
    color: "#38bdf8",
    weight: 1,
    opacity: 0.6,
    fillOpacity: 0.25
  }).addTo(mapInstance);

  // Core pin: bright cyan dot with white rim (visible on dark terrain)
  userHaloDot = L.circleMarker([latN, lonN], {
    radius: 7,
    color: "#ffffff",
    weight: 2,
    fillColor: "#38bdf8",
    fillOpacity: 1.0,
    opacity: 1.0
  }).addTo(mapInstance);
  userHaloDot.bindPopup(popupHtml);
  userLocationMarker.bindPopup(popupHtml).openPopup();
}

/**
 * Removes the user marker pair (used before each recenter to avoid stacking).
 */
function clearUserLocationMarker() {
  if (!mapInstance) return;
  if (userLocationMarker && mapInstance.hasLayer(userLocationMarker)) {
    mapInstance.removeLayer(userLocationMarker);
  }
  userLocationMarker = null;
  if (userHaloDot && mapInstance.hasLayer(userHaloDot)) {
    mapInstance.removeLayer(userHaloDot);
  }
  userHaloDot = null;
  if (userOuterGlow && mapInstance.hasLayer(userOuterGlow)) {
    mapInstance.removeLayer(userOuterGlow);
  }
  userOuterGlow = null;
  if (userAccuracyRing && mapInstance.hasLayer(userAccuracyRing)) {
    mapInstance.removeLayer(userAccuracyRing);
  }
  userAccuracyRing = null;
}

/**
 * Refreshes leaflet dimensions upon tab switching
 */
function invalidateMapSize() {
  if (mapInstance) {
    setTimeout(() => {
      mapInstance.invalidateSize();
    }, 100);
  }
}
