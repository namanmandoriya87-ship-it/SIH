"""
SIH Hyper-Local Heatwave & HTSI Platform Test Suite
Tests Biometeorological Fidelity and API Parity
"""
import sys
import unittest
from fastapi.testclient import TestClient

from calculator import (
    calculate_utci,
    compute_metrics,
    calculate_ward_risk,
    calculate_personal_risk
)
from main import app

class TestBiometeorologicalEngine(unittest.TestCase):
    def test_stull_wet_bulb(self):
        # 42C, 55% RH
        metrics = compute_metrics(ta=42.0, rh=55.0, va=1.5, solar_rad=800.0)
        tw = metrics["tw"]
        self.assertLessEqual(tw, 42.0, "Thermodynamic constraint violated: Tw > Ta")
        self.assertGreater(tw, 30.0, f"Tw {tw} should be realistically high at 42C/55%RH")

    def test_stull_saturation_constraint(self):
        # At 100% RH, Tw must equal Ta
        metrics = compute_metrics(ta=35.0, rh=100.0, va=1.0, solar_rad=0.0)
        self.assertAlmostEqual(metrics["tw"], 35.0, delta=0.5)

    def test_wbgt_outdoor_vs_indoor(self):
        outdoor = compute_metrics(ta=40.0, rh=50.0, va=1.5, solar_rad=800.0, exposure_type="outdoor")
        indoor = compute_metrics(ta=40.0, rh=50.0, va=1.5, solar_rad=800.0, exposure_type="indoor")
        
        # Outdoor WBGT must be higher than indoor due to direct solar radiation
        self.assertGreater(outdoor["wbgt"], indoor["wbgt"])
        self.assertAlmostEqual(indoor["tg"], 40.0, delta=0.01, msg="Indoor globe temperature must equal air temperature")
        self.assertGreater(outdoor["tg"], 40.0, msg="Outdoor globe temperature must exceed air temperature under 800 W/m2")

    def test_utci_brode_polynomial(self):
        # Standard hot outdoor conditions
        utci = calculate_utci(ta=42.0, tg=48.0, va=1.5, rh=50.0)
        self.assertGreater(utci, 40.0, f"UTCI {utci} should indicate severe thermal stress")
        self.assertLess(utci, 70.0, f"UTCI {utci} out of bounds")

    def test_personal_vulnerability_multipliers(self):
        raw_htsi = 60.0
        # Standard healthy adult, light activity
        risk_base = calculate_personal_risk(raw_htsi=raw_htsi, age=30, has_preexisting_condition=False, activity_level="light")
        # Elderly adult (>65)
        risk_elderly = calculate_personal_risk(raw_htsi=raw_htsi, age=72, has_preexisting_condition=False, activity_level="light")
        # Adult with preexisting condition and heavy labor
        risk_vulnerable = calculate_personal_risk(raw_htsi=raw_htsi, age=50, has_preexisting_condition=True, activity_level="heavy")
        
        self.assertEqual(risk_base["v_mult"], 1.0)
        self.assertAlmostEqual(risk_elderly["v_mult"], 1.15, delta=0.01)
        self.assertAlmostEqual(risk_vulnerable["v_mult"], 1.20 * 1.15, delta=0.01)
        
        self.assertGreater(risk_vulnerable["adjusted_htsi"], risk_base["adjusted_htsi"])
        self.assertIn("safe_window", risk_vulnerable)
        self.assertIn("cardio_strain", risk_vulnerable)

    def test_ward_demographic_risk(self):
        raw_htsi = 55.0
        ward_risk = calculate_ward_risk(raw_htsi=raw_htsi, elderly_pct=14.5, outdoor_worker_pct=42.0, ndvi=0.12, population=125000)
        self.assertGreater(ward_risk["v_mult"], 1.0)
        self.assertGreater(ward_risk["relative_risk"], 1.0)
        self.assertGreater(ward_risk["mri"], 0.0)
        self.assertGreater(ward_risk["projected_cases"], 0.0)


class TestFastAPIEndpoints(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_get_wards_geojson(self):
        res = self.client.get("/api/wards/geojson")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIsInstance(data, list)
        self.assertEqual(len(data), 6)
        self.assertEqual(data[0]["id"], "W01")
        self.assertIn("coords", data[0])

    def test_calculate_simulation_outdoor(self):
        payload = {
            "ta": 42.0,
            "rh": 55.0,
            "va": 1.5,
            "solar_rad": 800.0,
            "duration_hours": 4.0,
            "exposure_type": "outdoor",
            "age": 30,
            "has_preexisting_condition": False,
            "activity_level": "light",
            "ward_id": "W01"
        }
        res = self.client.post("/api/calculate", json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("metrics", data)
        self.assertIn("personal_risk", data)
        self.assertIn("ward_risk", data)
        self.assertEqual(data["metrics"]["exposure_type"], "outdoor")

    def test_calculate_simulation_indoor(self):
        payload = {
            "ta": 42.0,
            "rh": 55.0,
            "va": 1.5,
            "solar_rad": 800.0,
            "duration_hours": 4.0,
            "exposure_type": "indoor",
            "age": 70,
            "has_preexisting_condition": True,
            "activity_level": "moderate"
        }
        res = self.client.post("/api/calculate", json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["metrics"]["exposure_type"], "indoor")
        self.assertAlmostEqual(data["metrics"]["tg"], 42.0, delta=0.01)

    def test_forecast_endpoint(self):
        res = self.client.get("/api/forecast/5day?lat=28.6139&lon=77.2090")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("timeline", data)
        self.assertGreater(len(data["timeline"]), 0)
        first_step = data["timeline"][0]
        self.assertIn("wards", first_step)
        self.assertIn("W01", first_step["wards"])

    def test_alert_dispatch(self):
        payload = {
            "ward_id": "W01",
            "htsi": 78.5,
            "channel": "whatsapp"
        }
        res = self.client.post("/api/alerts/dispatch", json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "success")
        self.assertIn("DISP-W01", data["dispatch_id"])

if __name__ == "__main__":
    unittest.main()
