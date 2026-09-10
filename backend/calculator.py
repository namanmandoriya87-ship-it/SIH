"""
Hyper-Local Heatwave Early Warning & Human Thermal Stress Index (HTSI)
Core Biometeorological & Epidemiological Mathematical Engine
"""
import numpy as np

def calculate_utci(ta: float, tg: float, va: float, rh: float) -> float:
    """
    Bounded, mathematically stable Standard Operational UTCI approximation.
    Replaces the 6th-order Brode polynomial (which diverged to ~152C).
    Mean radiant temperature derived from globe temperature, wind capped,
    output physiologically clipped to [-20, 65]C.
    """
    tmrt = float(tg) + 1.5 * (float(tg) - float(ta))
    va_capped = max(0.5, min(float(va), 15.0))
    delta_utci = (0.607 * (tmrt - float(ta))
                  - 0.585 * (va_capped - 0.5)
                  + 0.082 * (float(rh) - 50.0)
                  + 0.0014 * (float(ta) - 25.0) * float(rh))
    utci = float(ta) + float(delta_utci)
    return float(np.clip(utci, -20.0, 65.0))


def compute_metrics(
    ta: float, 
    rh: float, 
    va: float, 
    solar_rad: float, 
    duration_hours: float = 4.0,
    exposure_type: str = "outdoor"
):
    """
    Computes Stull Wet-Bulb, ISO 7243 WBGT (Outdoor or Indoor), NOAA Heat Index,
    bounded operational UTCI, normalized indices, and composite raw HTSI.
    Step-1 spec: bounded stable UTCI formulation, physiologically clipped.
    """
    ta = float(ta)
    rh = float(np.clip(rh, 1.0, 100.0))
    va = float(max(va, 0.1))
    solar_rad = float(max(solar_rad, 0.0))
    duration_hours = float(max(duration_hours, 0.0))
    is_indoor = exposure_type.lower() == "indoor"

    # 1. Stull's Wet-Bulb approximation (°C) — Step-1 spec
    tw = (ta * np.arctan(0.151977 * np.sqrt(rh + 8.313659)) +
          np.arctan(ta + rh) - np.arctan(rh - 1.676331) +
          0.00391838 * (rh ** 1.5) * np.arctan(0.023101 * rh) - 4.686035)
    tw = min(float(tw), ta)  # Thermodynamic constraint: Tw <= Ta

    # 2. Black Globe Temp (Tg) & WBGT — Step-1 spec formulation
    actual_solar = solar_rad if not is_indoor else 0.0
    tg = ta + (0.012 * actual_solar / (1.0 + 0.15 * max(va, 0.2)))

    if is_indoor:
        wbgt = (0.7 * tw) + (0.3 * tg)
    else:
        wbgt = (0.7 * tw) + (0.2 * tg) + (0.1 * ta)

    # 3. NOAA Heat Index (Rothfusz Regression — CORRECT Fahrenheit units).
    # NOTE: Step-1 paste applied Rothfusz coefficients directly to Celsius,
    # which explodes (30C/60% -> 171C). Rothfusz is defined in Fahrenheit,
    # so convert Ta->F, apply polynomial, convert back. max(Ta,HI) retained.
    tf = (ta * 9.0 / 5.0) + 32.0
    r = rh
    hi_f = (-42.379 + 2.04901523 * tf + 10.14333127 * r - 0.22475541 * tf * r
            - 0.00683783 * (tf ** 2) - 0.05481717 * (r ** 2) + 0.00122874 * (tf ** 2) * r
            + 0.00085282 * tf * (r ** 2) - 0.00000199 * (tf ** 2) * (r ** 2))
    hi_c = (hi_f - 32.0) * 5.0 / 9.0
    # Hi should not be lower than air temp in hot weather
    hi_c = max(ta, float(hi_c))

    # 4. Standard Operational UTCI Approximation (Bounded, Step-1 spec)
    utci = calculate_utci(ta=ta, tg=tg, va=va, rh=rh)

    # 5. Normalization (0 - 100) — Step-1 spec
    # WBGT: 25 - 34°C
    s_wbgt = 100.0 * float(np.clip((wbgt - 25.0) / (34.0 - 25.0), 0.0, 1.0))
    # UTCI: 26 - 46°C
    s_utci = 100.0 * float(np.clip((utci - 26.0) / (46.0 - 26.0), 0.0, 1.0))
    # Heat Index: 27 - 54°C
    s_hi = 100.0 * float(np.clip((hi_c - 27.0) / (54.0 - 27.0), 0.0, 1.0))
    # Exposure Duration: t / 8.0 h (clipped 0 to 1.5)
    s_dur = 100.0 * float(np.clip(duration_hours / 8.0, 0.0, 1.5))

    # 6. Composite Raw HTSI — Step-1 spec
    raw_htsi = (0.40 * s_wbgt) + (0.30 * s_utci) + (0.20 * s_hi) + (0.10 * s_dur)

    return {
        "wbgt": round(float(wbgt), 1),
        "utci": round(float(utci), 1),
        "heat_index": round(float(hi_c), 1),
        "raw_htsi": round(float(raw_htsi), 1),
        "tw": round(float(tw), 1),
        "tg": round(float(tg), 1),
        "s_wbgt": round(float(s_wbgt), 1),
        "s_utci": round(float(s_utci), 1),
        "s_hi": round(float(s_hi), 1),
        "s_dur": round(float(s_dur), 1),
        "exposure_type": exposure_type
    }


def calculate_ward_risk(raw_htsi: float, elderly_pct: float, outdoor_worker_pct: float, ndvi: float, population: int):
    """
    Applies ward-level demographic multipliers, computing Adjusted HTSI,
    Poisson DLNM Relative Risk (RR), Mortality Risk Index (MRI), and hospital surges.
    """
    elderly_pct = float(max(0.0, elderly_pct))
    outdoor_worker_pct = float(max(0.0, outdoor_worker_pct))
    ndvi = float(np.clip(ndvi, 0.0, 1.0))
    population = int(max(1, population))

    # 1. Ward Demographic Vulnerability Multiplier
    # Elderly (>65) vulnerability + Outdoor worker exposure + Urban heat island factor (1 - NDVI)
    v_mult = 1.0 + (0.20 * (elderly_pct / 10.0)) + (0.25 * (outdoor_worker_pct / 30.0)) + (0.15 * (1.0 - ndvi))
    adjusted_htsi = float(np.clip(raw_htsi * v_mult, 0.0, 100.0))

    # 2. Poisson DLNM Exponential Relative Risk
    excess_exposure = max(0.0, adjusted_htsi - 45.0)
    rr = float(np.exp(0.028 * excess_exposure))

    # 3. Mortality Risk Index (MRI, 0 - 100 scale)
    mri = float(100.0 * np.clip(np.log(rr) / np.log(2.2), 0.0, 1.0))

    # 4. Attributable excess hospital admissions / day
    baseline_daily_rate_per_100k = 2.1
    attributable_rate = ((rr - 1.0) / rr) if rr > 1.0 else 0.0
    excess_cases = round(attributable_rate * baseline_daily_rate_per_100k * (population / 100000.0), 1)

    # 5. Alert classification and color coding
    if adjusted_htsi < 40.0:
        band = "Safe / Normal"
        color = "#22c55e"
        advisory = "Green Status: Baseline heat conditions. Routine civic operations continue unhindered."
    elif adjusted_htsi < 60.0:
        band = "Moderate Alert"
        color = "#eab308"
        advisory = "Yellow Alert: Hydration kiosks mobilized across major junctions. Advise elderly and outdoor workers to seek shade between 12:00 and 15:30."
    elif adjusted_htsi < 75.0:
        band = "Severe Caution"
        color = "#f97316"
        advisory = "Orange Alert: Moratorium on heavy outdoor construction labor from 11:30 to 16:30. Dedicated primary health clinic cooling bays operationalized."
    else:
        band = "Extreme Danger / Emergency"
        color = "#ef4444"
        advisory = "RED EMERGENCY PROTOCOL: Severe physiological failure risk. Water misting deployed, power grids locked for continuous cooling, emergency triage activated."

    return {
        "adjusted_htsi": round(float(adjusted_htsi), 1),
        "v_mult": round(float(v_mult), 3),
        "mri": round(float(mri), 1),
        "relative_risk": round(rr, 2),
        "projected_cases": excess_cases,
        "band": band,
        "color": color,
        "advisory": advisory
    }


def calculate_personal_risk(
    raw_htsi: float,
    age: int = 30,
    has_preexisting_condition: bool = False,
    activity_level: str = "light",
    population: int = 100000
):
    """
    Translates meteorological raw HTSI into personal physiological thermal strain
    incorporating age, pre-existing conditions, and physical activity level.
    """
    age = int(max(1, min(120, age)))
    
    # 1. Personal vulnerability multipliers
    # Age factor: Children (<12) and Elderly (>65) have compromised thermoregulation (+15%)
    age_penalty = 0.15 if (age > 65 or age < 12) else 0.0
    
    # Health factor: Cardiovascular, respiratory, diabetes (+20%)
    health_penalty = 0.20 if has_preexisting_condition else 0.0
    
    # Physical activity factor: Internal metabolic heat production
    activity_map = {
        "light": 1.0,
        "moderate": 1.10,
        "heavy": 1.15
    }
    act_mult = activity_map.get(activity_level.lower(), 1.0)
    
    # Combined personal vulnerability multiplier
    v_personal = (1.0 + age_penalty + health_penalty) * act_mult
    adjusted_htsi = float(np.clip(raw_htsi * v_personal, 0.0, 100.0))

    # 2. Poisson DLNM Relative Risk
    excess_exposure = max(0.0, adjusted_htsi - 45.0)
    rr = float(np.exp(0.028 * excess_exposure))
    mri = float(100.0 * np.clip(np.log(rr) / np.log(2.2), 0.0, 1.0))

    # Attributable cohort cases
    baseline_daily_rate_per_100k = 2.1
    attributable_rate = ((rr - 1.0) / rr) if rr > 1.0 else 0.0
    excess_cases = round(attributable_rate * baseline_daily_rate_per_100k * (population / 100000.0), 1)

    # 3. Individualized Safe Exposure Window and Cardiovascular Strain Advisory
    if adjusted_htsi < 40.0:
        band = "Safe / Normal"
        color = "#22c55e"
        safe_window = "Unrestricted normal outdoor activity with routine hydration."
        cardio_strain = "Normal resting cardiovascular baseline. Minimal thermal load."
        advisory = "Normal conditions. Maintain adequate fluid intake during exertion."
    elif adjusted_htsi < 60.0:
        band = "Moderate Alert"
        color = "#eab308"
        safe_window = "Safe continuous exposure up to 120 minutes. Mandatory 15-min shade & water break."
        cardio_strain = "Moderate peripheral vasodilation & elevated heart rate (+15-25 bpm)."
        advisory = "Yellow Alert: Increased cardiac workload. Vulnerable individuals should avoid direct midday sunlight."
    elif adjusted_htsi < 75.0:
        band = "Severe Caution"
        color = "#f97316"
        safe_window = "Limit continuous thermal exposure to 45 minutes. Cease strenuous manual work."
        cardio_strain = "High cardiovascular strain: heavy sweating, electrolyte depletion, risk of heat exhaustion."
        advisory = "Orange Alert: Moratorium on heavy outdoor exertion. Move to cool shaded or air-conditioned areas."
    else:
        band = "Extreme Danger / Emergency"
        color = "#ef4444"
        safe_window = "Acute danger: Thermal collapse possible within 15 minutes of strenuous exertion."
        cardio_strain = "Critical myocardial and thermoregulatory strain. High risk of heat stroke and systemic failure."
        advisory = "RED EMERGENCY: Severe threat to survival. Cease all physical activity immediately, apply cold compresses, seek immediate cool shelter."

    return {
        "adjusted_htsi": round(float(adjusted_htsi), 1),
        "v_mult": round(float(v_personal), 3),
        "mri": round(float(mri), 1),
        "relative_risk": round(rr, 2),
        "projected_cases": excess_cases,
        "band": band,
        "color": color,
        "safe_window": safe_window,
        "cardio_strain": cardio_strain,
        "advisory": advisory,
        "age_penalty": age_penalty,
        "health_penalty": health_penalty,
        "activity_mult": act_mult
    }


def calculate_physiological_breakdown(ta: float, wbgt: float, duration_hours: float,
                                      activity_level: str, age: int, has_health: bool):
    """
    Estimates core internal temperature (Tcore) escalation driven by
    WBGT heat storage, heavy exertion, and pre-existing health conditions.
    """
    lvl = (activity_level or "light").lower()

    # Core temperature escalation approximation:
    # Baseline normal: 37.0C. Strenuous work + severe WBGT creates heat storage.
    t_core_baseline = 37.0
    storage_rate = 0.0
    if float(wbgt) > 27.0:
        storage_rate += (float(wbgt) - 27.0) * 0.08
    if lvl == "heavy":
        storage_rate += 0.25
    if has_health:
        storage_rate += 0.15

    # Core temperature rises with prolonged duration if storage rate > 0
    t_core = min(41.0, t_core_baseline + (storage_rate * min(float(duration_hours), 4.0) * 0.35))

    # Clinical status
    if t_core < 37.5:
        core_status = "Safe Baseline"
        core_color = "#22c55e"
    elif t_core < 38.3:
        core_status = "Thermal Strain / Vasodilation"
        core_color = "#f59e0b"
    elif t_core < 39.2:
        core_status = "Heat Exhaustion Imminent"
        core_color = "#f97316"
    else:
        core_status = "CRITICAL: Exertional Heatstroke"
        core_color = "#ef4444"

    return {
        "t_core": round(float(t_core), 1),
        "core_status": core_status,
        "core_color": core_color
    }

