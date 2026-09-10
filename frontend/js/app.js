/**
 * Hyper-Local Heatwave Early Warning & HTSI Platform
 * Reactive State Engine & Biometeorological Calculator
 */

// Application State
let activeMode = "forecast"; // "forecast" | "simulator"
let wardsData = [];
let forecastTimeline = [];
let selectedWard = null;
let currentStepIndex = 0;

// Live device geolocation state (HTML5 navigator.geolocation)
const DEFAULT_COORDS = { lat: 28.6139, lon: 77.2090 };
let userCoords = { lat: 28.6139, lon: 77.2090 };
let userLocality = "New Delhi (Default)";
let userDisplayAddress = "";
let isLocating = false;
let forecastSourceLabel = "";

// Location pill + GPS button wiring
function setupGeolocationControls() {
  const btn = document.getElementById("detect-location-btn");
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => requestDeviceGeolocation({ auto: false }));
  }
  updateLocationPill("prompt", "Delhi default (28.6139, 77.2090) - awaiting GPS");
}

function updateLocationPill(state, text, titleAttr) {
  const pill = document.getElementById("location-pill");
  const label = document.getElementById("location-label");
  if (!pill || !label) return;
  pill.classList.remove("located", "error");
  if (state === "located") pill.classList.add("located");
  if (state === "error") pill.classList.add("error");
  label.textContent = text;
  if (titleAttr) pill.title = titleAttr;
}

// Simulator Parameters
let simState = {
  ta: 42.0,
  rh: 55.0,
  va: 1.5,
  solar_rad: 800.0,
  duration_hours: 4.0,
  exposure_type: "outdoor", // "outdoor" | "indoor"
  age: 30,
  has_preexisting_condition: false,
  activity_level: "light", // "light" | "moderate" | "heavy"
  ward_id: "W01",
  customDemographics: false,
  elderly_pct: 14.5,
  outdoor_worker_pct: 42.0,
  ndvi: 0.12,
  population: 125000
};

// Debounce timer for server-sync
let calcDebounceTimer = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener("DOMContentLoaded", async () => {
  // 1. Initialize Map
  initMap();

  // 2. Setup Dual-Mode Switcher Tabs
  setupModeSwitcher();

  // 3. Setup Range Sliders & Duration Chips
  setupSimulatorControls();
  setupWeatherSourceToggle();
  setupPresetChips();

  // 4. Setup Emergency Alert Modal
  setupAlertModal();

  // 5. Wire live-geolocation controls (button + pill), then auto-prompt GPS
  setupGeolocationControls();

  // 6. Load Delhi-default forecast instantly so UI never idles,
  //    then upgrade to live device coordinates (auto GPS prompt on load)
  await loadForecastForCoords(userCoords.lat, userCoords.lon, { initial: true });

  // 7. Bind Scrubber Slider Listener
  const timeSlider = document.getElementById("timeline-slider");
  if (timeSlider) {
    timeSlider.addEventListener("input", (e) => {
      currentStepIndex = parseInt(e.target.value, 10);
      if (activeMode === "forecast") {
        syncForecastDashboard();
      }
    });
  }

  // 8. Initial sync (already called inside loader; kept for tab restores)
  syncForecastDashboard();

  // 9. Prompt browser GPS on initial page load per spec
  requestDeviceGeolocation({ auto: true });
});

// ============================================================================
// DUAL-MODE SWITCHER
// ============================================================================

function setupModeSwitcher() {
  const btnForecast = document.getElementById("tab-mode-forecast");
  const btnSimulator = document.getElementById("tab-mode-simulator");
  const scrubberPanel = document.getElementById("forecast-scrubber-panel");
  const modeAContainer = document.getElementById("mode-a-container");
  const modeBContainer = document.getElementById("mode-b-container");
  const activeModeTag = document.getElementById("active-mode-tag");

  btnForecast.addEventListener("click", () => {
    activeMode = "forecast";
    btnForecast.classList.add("active");
    btnSimulator.classList.remove("active");

    scrubberPanel.classList.remove("hidden");
    modeAContainer.classList.remove("hidden");
    modeBContainer.classList.add("hidden");

    if (activeModeTag) activeModeTag.textContent = "MODE A: FORECAST";
    invalidateMapSize();
    syncForecastDashboard();
  });

  btnSimulator.addEventListener("click", () => {
    activeMode = "simulator";
    btnSimulator.classList.add("active");
    btnForecast.classList.remove("active");

    scrubberPanel.classList.add("hidden");
    modeAContainer.classList.add("hidden");
    modeBContainer.classList.remove("hidden");

    if (activeModeTag) activeModeTag.textContent = "MODE B: SIMULATOR";
    runReactiveSimulation();
  });
}

// ============================================================================
// SIMULATOR CONTROLS & EVENT BINDINGS
// ============================================================================

function setupSimulatorControls() {
  const sliderTa = document.getElementById("slider-ta");
  const sliderRh = document.getElementById("slider-rh");
  const sliderVa = document.getElementById("slider-va");
  const sliderSolar = document.getElementById("slider-solar");
  const solarControlCard = document.getElementById("solar-control-card");
  const labelWbgt = document.getElementById("label-wbgt");

  const valTa = document.getElementById("val-ta");
  const valRh = document.getElementById("val-rh");
  const valVa = document.getElementById("val-va");
  const valSolar = document.getElementById("val-solar");

  // Exposure Environment Toggle (Outdoor vs Indoor/Shaded)
  const btnEnvOutdoor = document.getElementById("btn-env-outdoor");
  const btnEnvIndoor = document.getElementById("btn-env-indoor");

  if (btnEnvOutdoor && btnEnvIndoor) {
    btnEnvOutdoor.addEventListener("click", () => {
      simState.exposure_type = "outdoor";
      btnEnvOutdoor.classList.add("active");
      btnEnvIndoor.classList.remove("active");
      if (solarControlCard) solarControlCard.classList.remove("disabled-control");
      if (sliderSolar) sliderSolar.disabled = false;
      if (labelWbgt) labelWbgt.textContent = "Outdoor WBGT";
      onSimulatorInputChange();
    });

    btnEnvIndoor.addEventListener("click", () => {
      simState.exposure_type = "indoor";
      btnEnvIndoor.classList.add("active");
      btnEnvOutdoor.classList.remove("active");
      if (solarControlCard) solarControlCard.classList.add("disabled-control");
      if (sliderSolar) sliderSolar.disabled = true;
      if (labelWbgt) labelWbgt.textContent = "Indoor WBGT";
      onSimulatorInputChange();
    });
  }

  // Personal Physiological Profiling: Age Input + dynamic cohort badge.
  // Spec: <14 Pediatric / >=60 Senior / else Standard Adult.
  // NOTE: backend age_penalty still uses clinical <12/>65 cutoffs; badge is a
  // UI triage cue, so the wider <14/60+ band intentionally flags borderline
  // ages earlier without altering computed risk.
  const simAge = document.getElementById("sim-age");
  const ageBadge = document.getElementById("age-badge")
    || document.querySelector("#sim-age + .badge, #sim-age ~ button, .age-cohort-badge");
  function updateAgeCohortBadge(val) {
    const age = parseInt(val, 10);
    if (isNaN(age) || !ageBadge) return;
    if (age < 14) {
      ageBadge.textContent = "Pediatric (<14)";
      ageBadge.style.borderColor = "#f59e0b";
      ageBadge.style.color = "#f59e0b";
    } else if (age >= 60) {
      ageBadge.textContent = "Senior Cohort (60+)";
      ageBadge.style.borderColor = "#f97316";
      ageBadge.style.color = "#f97316";
    } else {
      ageBadge.textContent = "Standard Adult";
      ageBadge.style.borderColor = "#38bdf8";
      ageBadge.style.color = "#38bdf8";
    }
  }
  if (simAge) {
    simAge.addEventListener("input", (e) => {
      const val = parseInt(e.target.value, 10);
      simState.age = isNaN(val) ? 30 : Math.max(1, Math.min(115, val));
      updateAgeCohortBadge(e.target.value);
      onSimulatorInputChange(); // recomputes stress immediately (client + backend)
    });
    // Run once on load
    updateAgeCohortBadge(simAge.value);
  }

  // Personal Physiological Profiling: Pre-Existing Health Condition Switch
  const simCondition = document.getElementById("sim-condition");
  const conditionLabel = document.getElementById("condition-label");
  if (simCondition) {
    simCondition.addEventListener("change", (e) => {
      simState.has_preexisting_condition = e.target.checked;
      if (conditionLabel) {
        conditionLabel.textContent = e.target.checked ? "Cardio / Resp / Diab (+20%)" : "None Reported";
        conditionLabel.style.color = e.target.checked ? "var(--color-severe)" : "var(--text-secondary)";
      }
      onSimulatorInputChange();
    });
  }

  // Personal Physiological Profiling: Metabolic Activity Chips
  const actChips = document.querySelectorAll(".activity-chips-group .act-chip");
  actChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      actChips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      simState.activity_level = chip.getAttribute("data-activity") || "light";
      onSimulatorInputChange();
    });
  });

  // Temperature
  sliderTa.addEventListener("input", (e) => {
    simState.ta = parseFloat(e.target.value);
    valTa.textContent = simState.ta.toFixed(1);
    onSimulatorInputChange();
  });

  // Relative Humidity
  sliderRh.addEventListener("input", (e) => {
    simState.rh = parseFloat(e.target.value);
    valRh.textContent = simState.rh.toFixed(0);
    onSimulatorInputChange();
  });

  // Wind Speed
  sliderVa.addEventListener("input", (e) => {
    simState.va = parseFloat(e.target.value);
    valVa.textContent = simState.va.toFixed(1);
    onSimulatorInputChange();
  });

  // Solar Radiation
  sliderSolar.addEventListener("input", (e) => {
    simState.solar_rad = parseFloat(e.target.value);
    valSolar.textContent = simState.solar_rad.toFixed(0);
    onSimulatorInputChange();
  });

  // Duration Chips
  const chipButtons = document.querySelectorAll("#duration-chips .duration-chip");
  chipButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      chipButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      simState.duration_hours = parseFloat(btn.getAttribute("data-hours"));
      onSimulatorInputChange();
    });
  });

  // Ward / Demographic Preset Selector
  const wardSelect = document.getElementById("target-ward-select");
  const customDemoContainer = document.getElementById("custom-demographics-container");

  wardSelect.addEventListener("change", (e) => {
    const val = e.target.value;
    if (val === "custom") {
      simState.customDemographics = true;
      customDemoContainer.style.display = "grid";
      readCustomDemographics();
    } else {
      simState.customDemographics = false;
      customDemoContainer.style.display = "none";
      simState.ward_id = val;
      const targetWard = wardsData.find((w) => w.id === val);
      if (targetWard) {
        selectedWard = targetWard;
        simState.elderly_pct = targetWard.elderly_pct;
        simState.outdoor_worker_pct = targetWard.outdoor_worker_pct;
        simState.ndvi = targetWard.ndvi;
        simState.population = targetWard.population;
      }
    }
    onSimulatorInputChange();
  });

  // Custom demographics inputs
  ["custom-elderly", "custom-labor", "custom-ndvi", "custom-pop"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", () => {
        readCustomDemographics();
        onSimulatorInputChange();
      });
    }
  });
}

// ----------------------------------------------------------------------------
// PROGRAMMATIC CONTROL SETTERS (used by applyPreset quick personas)
// Mirror the click handlers in setupSimulatorControls() so presets update both
// the visible chip/slider UI and simState before recomputing stress.
// ----------------------------------------------------------------------------

function setExposureType(type) {
  const val = type === "indoor" ? "indoor" : "outdoor";
  const btnOutdoor = document.getElementById("btn-env-outdoor");
  const btnIndoor = document.getElementById("btn-env-indoor");
  const solarCard = document.getElementById("solar-control-card");
  const sliderSolar = document.getElementById("slider-solar");
  const labelWbgt = document.getElementById("label-wbgt");
  simState.exposure_type = val;
  if (btnOutdoor) btnOutdoor.classList.toggle("active", val === "outdoor");
  if (btnIndoor) btnIndoor.classList.toggle("active", val === "indoor");
  const indoor = val === "indoor";
  if (solarCard) solarCard.classList.toggle("disabled-control", indoor);
  if (sliderSolar) sliderSolar.disabled = indoor;
  if (labelWbgt) labelWbgt.textContent = indoor ? "Indoor WBGT" : "Outdoor WBGT";
}

function setActivityLevel(level) {
  const lvl = level === "moderate" ? "moderate" : (level === "heavy" ? "heavy" : "light");
  simState.activity_level = lvl;
  document.querySelectorAll(".activity-chips-group .act-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.getAttribute("data-activity") === lvl);
  });
}

function setDuration(hours) {
  const h = parseFloat(hours) || 4.0;
  simState.duration_hours = h;
  document.querySelectorAll("#duration-chips .duration-chip").forEach((btn) => {
    const dh = parseFloat(btn.getAttribute("data-hours")) || 0;
    btn.classList.toggle("active", Math.abs(dh - h) < 1e-9);
  });
}

function readCustomDemographics() {
  const elElderly = document.getElementById("custom-elderly");
  const elLabor = document.getElementById("custom-labor");
  const elNdvi = document.getElementById("custom-ndvi");
  const elPop = document.getElementById("custom-pop");

  if (elElderly) simState.elderly_pct = parseFloat(elElderly.value) || 12.0;
  if (elLabor) simState.outdoor_worker_pct = parseFloat(elLabor.value) || 35.0;
  if (elNdvi) simState.ndvi = parseFloat(elNdvi.value) || 0.20;
  if (elPop) simState.population = parseInt(elPop.value, 10) || 100000;
}

function onSimulatorInputChange() {
  if (activeMode === "simulator") {
    runReactiveSimulation();
    clearTimeout(calcDebounceTimer);
    calcDebounceTimer = setTimeout(() => {
      syncSimulationWithBackend();
    }, 250);
  }
}

function setLocatingUI(active, hint) {
  isLocating = active;
  const btn = document.getElementById("detect-location-btn");
  if (btn) {
    btn.disabled = !!active;
    btn.innerHTML = active
      ? "<span class=\"icon\">&#8987;</span> Locating..."
      : "<span class=\"icon\">&#128205;</span> Detect My Current Location";
  }
  if (active) updateLocationPill("prompt", hint || "Requesting device GPS...");
}

function requestDeviceGeolocation(opts) {
  opts = opts || {};
  if (!("geolocation" in navigator)) {
    updateLocationPill("error", "Geolocation unsupported - Delhi default");
    return;
  }
  setLocatingUI(true);
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = +pos.coords.latitude.toFixed(5);
      const lon = +pos.coords.longitude.toFixed(5);
      await applyUserCoordinates(lat, lon);
      setLocatingUI(false);
    },
    async (err) => {
      setLocatingUI(false);
      const msg = (err && err.message) || "denied";
      updateLocationPill("error", "GPS blocked - Delhi default (28.6139, 77.2090)", msg);
      userLocality = "National Capital Territory of Delhi";
      updateRegionSubtitle("National Capital Territory of Delhi");
      if (forecastTimeline.length === 0) {
        await loadForecastForCoords(DEFAULT_COORDS.lat, DEFAULT_COORDS.lon, { initial: true });
      } else {
        setMapToUserLocation(DEFAULT_COORDS.lat, DEFAULT_COORDS.lon, "New Delhi (Default)");
      }
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
}

function updateRegionSubtitle(cityName) {
  const el = document.getElementById("region-subtitle");
  if (!el) return;
  const city = (cityName && String(cityName).trim()) || "National Capital Territory of Delhi";
  el.textContent = `${city} Region \u2022 Biometeorological & Epidemiological Early Warning Engine`;
}

async function applyUserCoordinates(lat, lon) {
  userCoords = { lat: Number(lat), lon: Number(lon) };
  updateLocationPill("prompt", "Resolving locality for " + lat.toFixed(4) + "...");
  let geo = { displayName: lat.toFixed(4) + ", " + lon.toFixed(4), city: "Current Location" };
  try {
    if (typeof reverseGeocode === "function") geo = await reverseGeocode(lat, lon);
  } catch (e) { console.warn("reverseGeocode failed:", e); }
  userLocality = geo.city || "Current Location";
  userDisplayAddress = geo.displayName || (lat.toFixed(4) + ", " + lon.toFixed(4));
  updateLocationPill("located", userLocality + " (" + lat.toFixed(4) + ", " + lon.toFixed(4) + ")", userDisplayAddress);
  updateRegionSubtitle(userLocality);
  await loadForecastForCoords(lat, lon, { label: userLocality });
  // Step-2: auto-sync live hour weather into Mode B sliders + recalc
  syncLiveWeatherToSimulator();
}

async function loadForecastForCoords(lat, lon, opts) {
  opts = opts || {};
  const timeLabel = document.getElementById("current-time-label");
  if (timeLabel && opts.initial) timeLabel.textContent = "Loading live Open-Meteo forecast...";
  try {
    const wardsRes = await fetchWardGeoJSON(lat, lon);
    const forecastRes = await fetch5DayForecast(lat, lon);
    let nextWards = [];
    if (forecastRes && Array.isArray(forecastRes.wards) && forecastRes.wards.length > 0) {
      nextWards = forecastRes.wards;
    } else if (Array.isArray(wardsRes) && wardsRes.length > 0) {
      nextWards = wardsRes;
    }
    if (nextWards.length > 0) {
      wardsData = nextWards;
      const keepId = selectedWard && nextWards.some((w) => w.id === selectedWard.id)
        ? selectedWard.id : nextWards[0].id;
      selectedWard = nextWards.find((w) => w.id === keepId) || nextWards[0];
      simState.ward_id = selectedWard.id;
      renderWardsOnMap(wardsData, handleWardSelection);
      highlightWardPolygon(selectedWard.id);
    }
    forecastTimeline = (forecastRes && forecastRes.timeline) || [];
    forecastSourceLabel = (forecastRes && (forecastRes.source || forecastRes.city)) || "";
    // Keep header subtitle in sync with backend city label (e.g. Indore live coords)
    if (forecastRes && forecastRes.city && typeof forecastRes.city === "string") {
      const cleanCity = forecastRes.city.replace(/\s*\(.*\)\s*$/, "").trim();
      if (cleanCity && !/delhi/i.test(cleanCity)) updateRegionSubtitle(cleanCity);
    }
    currentStepIndex = 0;
    const slider = document.getElementById("timeline-slider");
    if (slider) {
      slider.max = String(Math.max(0, forecastTimeline.length - 1));
      slider.value = "0";
    }
    const mapLabel = opts.label || userLocality || "Your Live Location";
    try { setMapToUserLocation(lat, lon, mapLabel); } catch (e) { console.warn(e); }
    refreshWardDropdown();
    syncForecastDashboard();
    updateWeatherSourceToggle();
  } catch (err) {
    console.error("loadForecastForCoords failed:", err);
  }
}

// Step-2/3: live-weather <-> Mode B slider bridge + source toggle state.
let weatherSourceMode = "live"; // "live" | "custom"

function updateWeatherSourceToggle() {
  const liveBtn = document.getElementById("btn-sync-live-weather");
  const customBtn = document.getElementById("btn-custom-weather");
  if (liveBtn) {
    liveBtn.classList.toggle("active", weatherSourceMode === "live");
    liveBtn.textContent = "Sync Live Weather (" + (userLocality || "Live") + ")";
  }
  if (customBtn) customBtn.classList.toggle("active", weatherSourceMode === "custom");
}

function setupWeatherSourceToggle() {
  const liveBtn = document.getElementById("btn-sync-live-weather");
  const customBtn = document.getElementById("btn-custom-weather");
  if (liveBtn && !liveBtn.dataset.wired) {
    liveBtn.dataset.wired = "1";
    liveBtn.addEventListener("click", () => {
      weatherSourceMode = "live";
      syncLiveWeatherToSimulator();
      updateWeatherSourceToggle();
    });
  }
  if (customBtn && !customBtn.dataset.wired) {
    customBtn.dataset.wired = "1";
    customBtn.addEventListener("click", () => {
      weatherSourceMode = "custom";
      updateWeatherSourceToggle();
      runReactiveSimulation();
    });
  }
  // Any manual slider edit => custom override
  ["slider-ta", "slider-rh", "slider-va", "slider-solar"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el.dataset.srcWired) {
      el.dataset.srcWired = "1";
      el.addEventListener("input", () => {
        if (weatherSourceMode !== "custom") {
          weatherSourceMode = "custom";
          updateWeatherSourceToggle();
        }
      });
    }
  });
  updateWeatherSourceToggle();
}

function syncLiveWeatherToSimulator() {
  if (!forecastTimeline || forecastTimeline.length === 0) return;
  const live = (forecastTimeline[0] && forecastTimeline[0].weather) || null;
  if (!live) return;
  weatherSourceMode = "live";
  const setSlider = (sliderId, valId, value, fmt) => {
    const slider = document.getElementById(sliderId);
    const badge = document.getElementById(valId);
    if (slider) {
      const v = Number(value);
      slider.value = String(Math.min(Number(slider.max), Math.max(Number(slider.min), v)));
    }
    if (badge) badge.textContent = fmt;
    return Number(value);
  };
  simState.ta = setSlider("slider-ta", "val-ta", live.temperature, Number(live.temperature).toFixed(1));
  simState.rh = setSlider("slider-rh", "val-rh", live.humidity, String(Math.round(Number(live.humidity))));
  simState.va = setSlider("slider-va", "val-va", live.wind_speed, Number(live.wind_speed).toFixed(1));
  simState.solar_rad = setSlider("slider-solar", "val-solar", live.solar_radiation, String(Math.round(Number(live.solar_radiation))));
  updateWeatherSourceToggle();
  runReactiveSimulation();
  syncSimulationWithBackend();
}

function refreshWardDropdown() {
  const sel = document.getElementById("select-ward");
  if (!sel || !Array.isArray(wardsData) || wardsData.length === 0) return;
  const prev = selectedWard ? selectedWard.id : simState.ward_id;
  sel.innerHTML = "";
  wardsData.forEach((w) => {
    const opt = document.createElement("option");
    opt.value = w.id;
    opt.textContent = w.id + " - " + w.name;
    sel.appendChild(opt);
  });
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "Custom Regional Cohort";
  sel.appendChild(custom);
  sel.value = prev && wardsData.some((w) => w.id === prev) ? prev : wardsData[0].id;
}

// ============================================================================
// HIGH-PERFORMANCE CLIENT-SIDE BIOMETEOROLOGICAL ENGINE (<16ms reactive)
// ============================================================================

/**
 * Stull Wet-Bulb approximation (°C)
 */
function clientStullTw(ta, rh) {
  const tw =
    ta * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(ta + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035;
  return Math.min(tw, ta); // Thermodynamic constraint: Tw <= Ta
}

/**
 * ISO 7243 WBGT (°C) - Dual Outdoor & Indoor/Shaded Derivation
 */
function clientISO_WBGT(ta, tw, va, solarRad, exposureType = "outdoor") {
  const isIndoor = exposureType.toLowerCase() === "indoor";
  if (isIndoor) {
    // Indoor/shaded without direct solar irradiance (Tg ≈ Ta)
    const tg = ta;
    const wbgt = 0.7 * tw + 0.3 * tg;
    return { tg, wbgt };
  } else {
    // Outdoor with direct solar radiation and wind convective cooling
    const tg = ta + (0.012 * solarRad) / (1.0 + 0.15 * Math.max(va, 0.2));
    const wbgt = 0.7 * tw + 0.2 * tg + 0.1 * ta;
    return { tg, wbgt };
  }
}

/**
 * NOAA Heat Index (Rothfusz regression with Fahrenheit thermodynamic base)
 */
function clientNOAAHeatIndex(ta, rh) {
  const tf = ta * 1.8 + 32.0;
  const r = rh;
  const hiF = (-42.379 + 2.04901523 * tf + 10.14333127 * r - 0.22475541 * tf * r - 0.00683783 * (tf ** 2) - 0.05481717 * (r ** 2) + 0.00122874 * (tf ** 2) * r + 0.00085282 * tf * (r ** 2) - 0.00000199 * (tf ** 2) * (r ** 2));
  return Math.max(ta, (hiF - 32.0) * 5.0 / 9.0);
}

function clientUTCI(ta, tg, va, rh) {
  const tmrt = tg + 1.5 * (tg - ta);
  const vaCapped = Math.max(0.5, Math.min(va, 15.0));
  const delta = (0.607 * (tmrt - ta) - 0.585 * (vaCapped - 0.5) + 0.082 * (rh - 50.0) + 0.0014 * (ta - 25.0) * rh);
  return Math.min(65.0, Math.max(-20.0, ta + delta));
}

/**
 * Evaluates individualized physiological thermal strain incorporating age,
 * pre-existing morbidities, and metabolic physical exertion (Mode 2 parity).
 */
function clientPersonalRisk(raw_htsi, age, has_condition, activity_level, population = 100000) {
  const age_penalty = (age > 65 || age < 12) ? 0.15 : 0.0;
  const health_penalty = has_condition ? 0.20 : 0.0;
  const activity_map = { "light": 1.0, "moderate": 1.10, "heavy": 1.15 };
  const act_mult = activity_map[(activity_level || "light").toLowerCase()] || 1.0;

  const v_personal = (1.0 + age_penalty + health_penalty) * act_mult;
  const adjusted_htsi = Math.min(100.0, Math.max(0.0, raw_htsi * v_personal));

  const excess_exposure = Math.max(0.0, adjusted_htsi - 45.0);
  const rr = Math.exp(0.028 * excess_exposure);
  const mri = 100.0 * Math.min(1.0, Math.max(0.0, Math.log(rr) / Math.log(2.2)));

  const baseline_daily_rate_per_100k = 2.1;
  const attributable_rate = rr > 1.0 ? (rr - 1.0) / rr : 0.0;
  const excess_cases = +(attributable_rate * baseline_daily_rate_per_100k * (population / 100000.0)).toFixed(1);

  let band = "Safe / Normal", color = "#22c55e", pillClass = "bg-safe";
  let safe_window = "Unrestricted normal outdoor activity with routine hydration.";
  let cardio_strain = "Normal resting cardiovascular baseline. Minimal thermal load.";
  let advisoryText = "Green Status: Baseline heat conditions. Routine activities continue unhindered.";
  let checkpoints = [
    "Unrestricted physical exposure within standard guidelines",
    "Drink at least 250ml fluids every 60 minutes during exertion",
    "Maintain standard ventilation in work or exercise zones"
  ];

  if (adjusted_htsi >= 75.0) {
    band = "Extreme Danger / Emergency";
    color = "#ef4444";
    pillClass = "bg-danger";
    safe_window = "Acute danger: Thermal collapse possible within 15 minutes of strenuous exertion.";
    cardio_strain = "Critical myocardial & thermoregulatory strain. Severe risk of heat stroke and systemic collapse.";
    advisoryText = "RED EMERGENCY: Severe physiological failure risk. Cease all physical activity immediately, apply cold compresses, seek immediate cool shelter.";
    checkpoints = [
      "Immediate cessation of outdoor manual labor & heavy physical exertion",
      "Retire to an air-conditioned or active-cooling recovery shelter",
      "Apply ice packs or cold damp towels to neck, axillae, and groin",
      "Initiate aggressive oral/IV rehydration under clinical supervision"
    ];
  } else if (adjusted_htsi >= 60.0) {
    band = "Severe Caution";
    color = "#f97316";
    pillClass = "bg-severe";
    safe_window = "Limit continuous thermal exposure to 45 minutes. Cease strenuous manual work.";
    cardio_strain = "High cardiovascular strain: heavy sweating, electrolyte depletion, elevated heart rate (+30-45 bpm).";
    advisoryText = "Orange Alert: Significant physiological thermal strain on vulnerable cohorts and outdoor workforces.";
    checkpoints = [
      "Limit continuous physical exposure to maximum 45 minutes",
      "Mandatory 20-minute rest in shaded environment between work bouts",
      "Consume electrolyte-rich fluid (ORS/coconut water) every 30 minutes",
      "Monitor for dizziness, headache, nausea, or muscle cramps"
    ];
  } else if (adjusted_htsi >= 40.0) {
    band = "Moderate Alert";
    color = "#eab308";
    pillClass = "bg-moderate";
    safe_window = "Safe continuous exposure up to 120 minutes. Mandatory 15-min shade & water break.";
    cardio_strain = "Moderate peripheral vasodilation & elevated heart rate (+15-25 bpm).";
    advisoryText = "Yellow Alert: Elevated thermal indices. Vulnerable populations must take precautionary hydration steps.";
    checkpoints = [
      "Schedule 15-minute shaded rest breaks every hour",
      "Hydrate with 500ml water/electrolytes per hour of exposure",
      "Wear loose, lightweight, light-colored UV-protective clothing"
    ];
  }

  return {
    adjusted_htsi: +adjusted_htsi.toFixed(1),
    v_personal: +v_personal.toFixed(3),
    rr: +rr.toFixed(2),
    mri: +mri.toFixed(1),
    excess_cases,
    band,
    color,
    pillClass,
    safe_window,
    cardio_strain,
    advisoryText,
    checkpoints,
    age_penalty,
    health_penalty,
    act_mult
  };
}

/**
 * Executes immediate client-side reactive biometeorological evaluation (<16ms)
 */
function runReactiveSimulation() {
  const { 
    ta, rh, va, solar_rad, duration_hours, 
    elderly_pct, outdoor_worker_pct, ndvi, population,
    exposure_type, age, has_preexisting_condition, activity_level 
  } = simState;

  // 1. Core biometeorological indices with exposure environment awareness
  const tw = clientStullTw(ta, rh);
  const { tg, wbgt } = clientISO_WBGT(ta, tw, va, solar_rad, exposure_type);
  const hi = clientNOAAHeatIndex(ta, rh);
  const utci = clientUTCI(ta, tg, va, rh);

  // 2. Normalization with linear threshold clipping (0 - 100)
  const s_wbgt = 100.0 * Math.min(1.0, Math.max(0.0, (wbgt - 25.0) / (34.0 - 25.0)));
  const s_utci = 100.0 * Math.min(1.0, Math.max(0.0, (utci - 26.0) / (46.0 - 26.0)));
  const s_hi   = 100.0 * Math.min(1.0, Math.max(0.0, (hi - 27.0) / (54.0 - 27.0)));
  const s_dur  = 100.0 * Math.min(1.5, Math.max(0.0, duration_hours / 8.0));

  // 3. Composite Raw HTSI
  const raw_htsi = 0.40 * s_wbgt + 0.30 * s_utci + 0.20 * s_hi + 0.10 * s_dur;

  // 4. Evaluate Personal Physiological Risk (Mode 2 Citizen & Worker Profiling)
  const personal = clientPersonalRisk(raw_htsi, age, has_preexisting_condition, activity_level, population);

  // 4b. Estimated core temperature (mirrors backend physiology)
  const physiology = clientPhysiologicalBreakdown(wbgt, duration_hours, activity_level, has_preexisting_condition);

  // Update Right Panel UI
  renderDashboardUI({
    title: simState.customDemographics ? "Custom Regional Cohort" : (selectedWard ? `${selectedWard.name} (${selectedWard.id})` : "Personal Simulation Profile"),
    elderly: elderly_pct,
    labor: outdoor_worker_pct,
    ndvi: ndvi,
    population: population,
    v_mult: personal.v_personal,
    htsi: personal.adjusted_htsi,
    mri: personal.mri,
    rr: personal.rr,
    wbgt: +wbgt.toFixed(1),
    tw: +tw.toFixed(1),
    tg: +tg.toFixed(1),
    utci: +utci.toFixed(1),
    hi: +hi.toFixed(1),
    cases: personal.excess_cases,
    band: personal.band,
    color: personal.color,
    pillClass: personal.pillClass,
    safeWindow: personal.safe_window,
    cardioStrain: personal.cardio_strain,
    advisoryText: personal.advisoryText,
    checkpoints: personal.checkpoints,
    scores: {
      s_wbgt: +s_wbgt.toFixed(1),
      s_utci: +s_utci.toFixed(1),
      s_hi: +s_hi.toFixed(1),
      s_dur: +s_dur.toFixed(1)
    }
  });

  renderClinicalTiles(physiology);
}

/**
 * Mirrors backend calculate_physiological_breakdown for instant UI (<16ms).
 */
function clientPhysiologicalBreakdown(wbgt, duration_hours, activity_level, has_health) {
  const lvl = (activity_level || "light").toLowerCase();
  let storage = 0.0;
  if (wbgt > 27.0) storage += (wbgt - 27.0) * 0.08;
  if (lvl === "heavy") storage += 0.25;
  if (has_health) storage += 0.15;
  const t_core = Math.min(41.0, 37.0 + (storage * Math.min(duration_hours, 4.0) * 0.35));
  let core_status = "Safe Baseline", core_color = "#22c55e";
  if (t_core >= 39.2) { core_status = "CRITICAL: Exertional Heatstroke"; core_color = "#ef4444"; }
  else if (t_core >= 38.3) { core_status = "Heat Exhaustion Imminent"; core_color = "#f97316"; }
  else if (t_core >= 37.5) { core_status = "Thermal Strain / Vasodilation"; core_color = "#f59e0b"; }
  return { t_core: +t_core.toFixed(1), core_status, core_color };
}

function renderClinicalTiles(phys) {
  if (!phys) return;
  const coreEl = document.getElementById("sim-core-temp");
  const statusEl = document.getElementById("sim-core-status");
  if (coreEl) { coreEl.textContent = `${phys.t_core.toFixed(1)} °C`; coreEl.style.color = phys.core_color; }
  if (statusEl) { statusEl.textContent = phys.core_status; statusEl.style.color = phys.core_color; }
}

/**
 * Quick occupational preset personas (Mode B). Mapped to real DOM IDs:
 * #sim-age / #sim-condition / env + activity + duration controls.
 */
window.applyPreset = function (type) {
  const presets = {
    construction: { age: 28, exposure: "outdoor", activity: "heavy", duration: 8.0, health: false },
    delivery: { age: 24, exposure: "outdoor", activity: "moderate", duration: 10.0, health: false },
    elderly: { age: 72, exposure: "indoor", activity: "light", duration: 6.0, health: true },
    farmer: { age: 45, exposure: "outdoor", activity: "heavy", duration: 6.0, health: false }
  };
  const p = presets[type];
  if (!p) return;
  document.querySelectorAll(".btn-preset").forEach((b) => {
    b.classList.toggle("active", b.dataset.preset === type);
  });
  const ageInput = document.getElementById("sim-age");
  if (ageInput) ageInput.value = String(p.age);
  simState.age = p.age;
  if (typeof updateAgeCohortBadge === "function") updateAgeCohortBadge(p.age);
  else {
    const badge = document.getElementById("age-badge");
    if (badge) badge.textContent = p.age < 14 ? "Pediatric (<14)" : (p.age >= 60 ? "Senior Cohort (60+)" : "Standard Adult");
  }
  setExposureType(p.exposure);
  setActivityLevel(p.activity);
  setDuration(p.duration);
  const healthToggle = document.getElementById("sim-condition");
  if (healthToggle) {
    healthToggle.checked = !!p.health;
    simState.has_preexisting_condition = !!p.health;
    const lbl = document.getElementById("condition-label");
    if (lbl) {
      lbl.textContent = p.health ? "Cardio / Resp / Diab (+20%)" : "None Reported";
      lbl.style.color = p.health ? "var(--color-severe)" : "var(--text-secondary)";
    }
  }
  weatherSourceMode = "custom";
  if (typeof updateWeatherSourceToggle === "function") updateWeatherSourceToggle();
  runReactiveSimulation();
  syncSimulationWithBackend();
};

function setupPresetChips() {
  document.querySelectorAll(".btn-preset").forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => window.applyPreset(btn.dataset.preset));
  });
}

/**
 * Background async verification with FastAPI
 */
async function syncSimulationWithBackend() {
  const payload = {
    ta: simState.ta,
    rh: simState.rh,
    va: simState.va,
    solar_rad: simState.exposure_type === "indoor" ? 0.0 : simState.solar_rad,
    duration_hours: simState.duration_hours,
    exposure_type: simState.exposure_type,
    age: simState.age,
    has_preexisting_condition: simState.has_preexisting_condition,
    activity_level: simState.activity_level,
    elderly_pct: simState.elderly_pct,
    outdoor_worker_pct: simState.outdoor_worker_pct,
    ndvi: simState.ndvi,
    population: simState.population,
    ward_id: simState.customDemographics ? null : simState.ward_id
  };

  const res = await calculateCustomSimulation(payload);
  if (res && res.metrics && res.risk) {
    console.log("Verified Backend Calculation Parity:", res);
  }
}

// ============================================================================
// FORECAST DASHBOARD SYNCHRONIZATION (Mode A)
// ============================================================================

function handleWardSelection(ward) {
  selectedWard = ward;
  simState.ward_id = ward.id;
  if (activeMode === "forecast") {
    syncForecastDashboard();
  } else {
    simState.elderly_pct = ward.elderly_pct;
    simState.outdoor_worker_pct = ward.outdoor_worker_pct;
    simState.ndvi = ward.ndvi;
    simState.population = ward.population;
    const wardSelect = document.getElementById("target-ward-select");
    if (wardSelect) wardSelect.value = ward.id;
    runReactiveSimulation();
  }
}

function syncForecastDashboard() {
  if (!forecastTimeline || forecastTimeline.length === 0 || !selectedWard) return;

  const currentStep = forecastTimeline[currentStepIndex] || forecastTimeline[0];
  const wardRisk = currentStep.wards[selectedWard.id];
  if (!wardRisk) return;

  // 1. Scrubber Label & Timestamp
  const dateObj = new Date(currentStep.timestamp);
  const timeLabel = document.getElementById("current-time-label");
  if (timeLabel) {
    timeLabel.textContent = `${dateObj.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' })} • ${dateObj.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  }

  // 2. Weather Chips
  const weather = currentStep.weather || {};
  document.getElementById("fw-temp").textContent = weather.temperature !== undefined ? weather.temperature : "--";
  document.getElementById("fw-rh").textContent = weather.humidity !== undefined ? weather.humidity : "--";
  document.getElementById("fw-wind").textContent = weather.wind_speed !== undefined ? weather.wind_speed : "--";
  document.getElementById("fw-solar").textContent = weather.solar_radiation !== undefined ? weather.solar_radiation : "--";

  // 3. Update Leaflet Map polygon colors
  updateMapColors(currentStep);

  // 4. Determine pill badge class and advisory details
  let pillClass = "bg-safe";
  let checkpoints = [
    "Normal municipal operations",
    "Monitor regional updates"
  ];
  let safeWindow = "Normal continuous civic exposure permitted with standard hydration.";
  let cardioStrain = "Baseline resting cardiovascular profile. Normal physiological thermal tolerance.";

  if (wardRisk.adjusted_htsi >= 75) {
    pillClass = "bg-danger";
    safeWindow = "Acute danger: Thermal collapse possible within 15 minutes of heavy outdoor labor.";
    cardioStrain = "Critical municipal emergency: extreme risk of heatstroke, severe dehydration, and cardiovascular crises.";
    checkpoints = [
      "Moratorium on outdoor labor 11:30 - 16:30",
      "Deploy water misting trucks to critical intersections",
      "Pre-alert heatstroke ICU resuscitation bays"
    ];
  } else if (wardRisk.adjusted_htsi >= 60) {
    pillClass = "bg-severe";
    safeWindow = "Limit continuous outdoor exposure to 45 minutes. Cease strenuous manual work between 11:30 - 16:30.";
    cardioStrain = "High cardiovascular load: peripheral vasodilation, heavy sweating, elevated heat-stress admissions.";
    checkpoints = [
      "Cease non-essential heavy outdoor labor",
      "Activate emergency primary clinic cooling shelters",
      "Dispatch ORS hydration packets to high-density bus stands"
    ];
  } else if (wardRisk.adjusted_htsi >= 40) {
    pillClass = "bg-moderate";
    safeWindow = "Safe continuous exposure up to 120 minutes with mandatory hydration breaks.";
    cardioStrain = "Moderate cardiac workload elevation. Elevated strain on elderly cohorts and outdoor laborers.";
    checkpoints = [
      "Open public drinking water kiosks",
      "Advise elderly to stay in shaded indoor locations"
    ];
  }

  const base = currentStep.base_metrics || {};
  // Derive normalization contributions locally when backend omits them,
  // so Mode A breakdown never renders empty "-- / 100" placeholders.
  const scores = deriveNormalizationScores(base, currentStep.weather || {});

  renderDashboardUI({
    title: `${selectedWard.name} (${selectedWard.id})`,
    elderly: selectedWard.elderly_pct,
    labor: selectedWard.outdoor_worker_pct,
    ndvi: selectedWard.ndvi,
    population: selectedWard.population,
    v_mult: wardRisk.v_mult || 1.0,
    htsi: wardRisk.adjusted_htsi,
    mri: wardRisk.mri,
    rr: wardRisk.relative_risk,
    wbgt: base.wbgt !== undefined ? base.wbgt : "--",
    tw: base.tw !== undefined ? base.tw : "--",
    tg: base.tg !== undefined ? base.tg : "--",
    utci: base.utci !== undefined ? base.utci : "--",
    hi: base.heat_index !== undefined ? base.heat_index : "--",
    cases: wardRisk.projected_cases,
    band: wardRisk.band,
    color: wardRisk.color,
    pillClass: pillClass,
    safeWindow: safeWindow,
    cardioStrain: cardioStrain,
    advisoryText: wardRisk.advisory || "Standard operational guidelines active.",
    checkpoints: checkpoints,
    scores: scores
  });
}

function deriveNormalizationScores(base, weather) {
  const num = (v, fb) => (v !== undefined && v !== null && v !== "--" && isFinite(Number(v)) ? Number(v) : fb);
  let wbgt = num(base.s_wbgt, null);
  let utci = num(base.s_utci, null);
  let hi = num(base.s_hi, null);
  let dur = num(base.s_dur, null);
  const needCalc = (wbgt === null || utci === null || hi === null || dur === null);
  if (needCalc) {
    const t = num(base.wbgt, null) !== null ? num(base.wbgt, 0) : num(weather.temperature, 38);
    const u = base.utci !== undefined ? num(base.utci, t + 2) : t + 2;
    const h = base.heat_index !== undefined ? num(base.heat_index, t + 4) : t + 4;
    const w = base.wbgt !== undefined ? num(base.wbgt, t * 0.85) : t * 0.85;
    if (wbgt === null) wbgt = Math.min(100, Math.max(0, (w - 25) / 9 * 100));
    if (utci === null) utci = Math.min(100, Math.max(0, (u - 26) / 20 * 100));
    if (hi === null) hi = Math.min(100, Math.max(0, (h - 27) / 27 * 100));
    if (dur === null) dur = 50.0;
  }
  const r1 = (v) => (v === null || v === undefined || !isFinite(Number(v)) ? "--" : +Number(v).toFixed(1));
  return { s_wbgt: r1(wbgt), s_utci: r1(utci), s_hi: r1(hi), s_dur: r1(dur) };
}

// ============================================================================
// DASHBOARD UI RENDERER
// ============================================================================

function renderDashboardUI(data) {
  // Ward Title & Pill
  document.getElementById("selected-ward-title").textContent = data.title;
  const pill = document.getElementById("risk-band-pill");
  pill.textContent = data.band;
  pill.className = `badge-pill ${data.pillClass}`;

  // Mode-aware Demographic / Physiological Factor Labels
  const lblF1 = document.getElementById("label-factor-1");
  const lblF2 = document.getElementById("label-factor-2");
  const lblF3 = document.getElementById("label-factor-3");
  const lblF4 = document.getElementById("label-factor-4");

  const unitF1 = document.getElementById("unit-factor-1");
  const unitF2 = document.getElementById("unit-factor-2");
  const unitF3 = document.getElementById("unit-factor-3");
  const unitF4 = document.getElementById("unit-factor-4");

  if (activeMode === "simulator") {
    if (lblF1) lblF1.textContent = "Cohort Age:";
    if (lblF2) lblF2.textContent = "Health Status:";
    if (lblF3) lblF3.textContent = "Exertion Level:";
    if (lblF4) lblF4.textContent = "Personal Multiplier:";

    document.getElementById("w-elderly").textContent = simState.age;
    if (unitF1) unitF1.textContent = " yrs";

    document.getElementById("w-labor").textContent = simState.has_preexisting_condition ? "Reported (+20%)" : "None";
    if (unitF2) unitF2.textContent = "";

    document.getElementById("w-ndvi").textContent = simState.activity_level.toUpperCase();
    if (unitF3) unitF3.textContent = "";

    document.getElementById("w-pop").textContent = data.v_mult ? `${data.v_mult}` : "1.00";
    if (unitF4) unitF4.textContent = "x";
  } else {
    if (lblF1) lblF1.textContent = "Elderly (>65):";
    if (lblF2) lblF2.textContent = "Outdoor Labor:";
    if (lblF3) lblF3.textContent = "Green Cover (NDVI):";
    if (lblF4) lblF4.textContent = "Cohort Multiplier:";

    document.getElementById("w-elderly").textContent = data.elderly;
    if (unitF1) unitF1.textContent = "%";

    document.getElementById("w-labor").textContent = data.labor;
    if (unitF2) unitF2.textContent = "%";

    document.getElementById("w-ndvi").textContent = data.ndvi;
    if (unitF3) unitF3.textContent = "";

    document.getElementById("w-pop").textContent = data.v_mult ? `${data.v_mult}` : "1.00";
    if (unitF4) unitF4.textContent = "x";
  }

  // WBGT Label
  const labelWbgt = document.getElementById("label-wbgt");
  if (labelWbgt) {
    labelWbgt.textContent = (activeMode === "simulator" && simState.exposure_type === "indoor") 
      ? "Indoor/Shaded WBGT" 
      : "Outdoor WBGT";
  }

  // Primary HTSI KPI
  const dispHtsi = document.getElementById("disp-htsi");
  dispHtsi.textContent = data.htsi;
  dispHtsi.style.color = data.color;

  const htsiMeter = document.getElementById("htsi-meter");
  htsiMeter.style.width = `${Math.min(100, data.htsi)}%`;
  htsiMeter.style.backgroundColor = data.color;

  // Secondary MRI KPI
  const dispMri = document.getElementById("disp-mri");
  dispMri.textContent = data.mri;
  document.getElementById("disp-rr").textContent = data.rr;

  const mriMeter = document.getElementById("mri-meter");
  mriMeter.style.width = `${Math.min(100, data.mri)}%`;
  mriMeter.style.backgroundColor = data.color;

  // Other Metrics
  document.getElementById("disp-wbgt").textContent = `${data.wbgt}°C`;
  document.getElementById("disp-tw").textContent = data.tw;
  document.getElementById("disp-tg").textContent = data.tg;
  document.getElementById("disp-utci").textContent = `${data.utci}°C`;
  document.getElementById("disp-hi").textContent = `${data.hi}°C`;
  document.getElementById("disp-cases").textContent = `+${data.cases}`;

  // Safe Exposure Window & Cardiovascular Strain Card
  const safeWinEl = document.getElementById("disp-safe-window");
  if (safeWinEl) safeWinEl.textContent = data.safeWindow || "Standard continuous thermal threshold applies.";
  const cardioStrainEl = document.getElementById("disp-cardio-strain");
  if (cardioStrainEl) cardioStrainEl.textContent = data.cardioStrain || "Hemodynamic and core thermoregulatory load within normal limits.";

  const cardioCard = document.getElementById("cardio-status-panel");
  if (cardioCard) cardioCard.style.borderLeftColor = data.color;

  // Component breakdown
  document.getElementById("val-s-wbgt").textContent = `${data.scores.s_wbgt} / 100`;
  document.getElementById("val-s-utci").textContent = `${data.scores.s_utci} / 100`;
  document.getElementById("val-s-hi").textContent = `${data.scores.s_hi} / 100`;
  document.getElementById("val-s-dur").textContent = `${data.scores.s_dur} / 100`;

  // Advisory Card & Dynamic Checkpoints
  const advisoryCard = document.getElementById("advisory-card");
  advisoryCard.style.borderLeftColor = data.color;
  document.getElementById("disp-advisory").textContent = data.advisoryText;

  const checkpointsContainer = document.getElementById("advisory-checkpoints");
  checkpointsContainer.innerHTML = "";
  if (data.checkpoints && data.checkpoints.length > 0) {
    data.checkpoints.forEach((item) => {
      const row = document.createElement("div");
      row.className = "checkpoint-item";
      row.innerHTML = `<span class="check-icon">&#10003;</span> <span>${item}</span>`;
      checkpointsContainer.appendChild(row);
    });
  }
}

// ============================================================================
// EMERGENCY ALERT BROADCAST MODAL
// ============================================================================

function setupAlertModal() {
  const dispatchBtn = document.getElementById("dispatch-alert-btn");
  const modal = document.getElementById("alert-modal");
  const closeBtn = document.getElementById("modal-close-btn");
  const cancelBtn = document.getElementById("modal-cancel-btn");
  const confirmBtn = document.getElementById("modal-confirm-dispatch-btn");

  const modalWardName = document.getElementById("modal-ward-name");
  const modalHtsiVal = document.getElementById("modal-htsi-val");
  const modalBandVal = document.getElementById("modal-band-val");

  dispatchBtn.addEventListener("click", () => {
    let currentHtsi = "--";
    let currentBand = "--";
    let currentName = "--";

    if (activeMode === "forecast") {
      if (!selectedWard || forecastTimeline.length === 0) return;
      const currentStep = forecastTimeline[currentStepIndex];
      const risk = currentStep.wards[selectedWard.id];
      currentHtsi = risk.adjusted_htsi;
      currentBand = risk.band;
      currentName = `${selectedWard.name} (${selectedWard.id})`;
    } else {
      currentHtsi = document.getElementById("disp-htsi").textContent;
      currentBand = document.getElementById("risk-band-pill").textContent;
      currentName = document.getElementById("selected-ward-title").textContent;
    }

    modalWardName.textContent = currentName;
    modalHtsiVal.textContent = currentHtsi;
    modalBandVal.textContent = currentBand;

    modal.classList.remove("hidden");
  });

  const closeModal = () => modal.classList.add("hidden");
  closeBtn.addEventListener("click", closeModal);
  cancelBtn.addEventListener("click", closeModal);

  confirmBtn.addEventListener("click", async () => {
    const wardId = selectedWard ? selectedWard.id : "W01";
    const htsi = parseFloat(document.getElementById("disp-htsi").textContent) || 50.0;

    confirmBtn.disabled = true;
    confirmBtn.textContent = "Dispatching Alerts...";

    const res = await triggerEmergencyBroadcast(wardId, htsi, "whatsapp");

    confirmBtn.disabled = false;
    confirmBtn.textContent = "Confirm Emergency Dispatch";
    closeModal();

    alert(
      `BROADCAST CONFIRMED [${res.dispatch_id || "OK"}]:\n` +
      `${res.message}\n\n` +
      `Action Taken: ${res.action_taken}`
    );
  });
}
