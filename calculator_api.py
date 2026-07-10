"""Local calculator companion for the MiraiTech markup service.

This process lives with the markup tool and imports the existing calculator
implementations read-only from the sibling MiraiTech backend checkout. It does
not add or change any backend API routes.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List

import pandas as pd
from fastapi import Body, FastAPI, HTTPException


BACKEND_ROOT = Path(__file__).resolve().parent.parent / "MiraiTech-backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


app = FastAPI(title="MiraiTech Markup Calculators")

CALCULATOR_LABELS = {
    "step-detector-ttest": "Step Detector T-Test",
    "tkeo-cadence": "TKEO Cadence",
    "step-cadence": "Step Cadence",
}

SENSOR_TO_FOOT = {
    "ESP32_Sensor_1": "left",
    "ESP32_Sensor_2": "right",
}


def _mean_or_none(values: Iterable[float]) -> float | None:
    values = list(values)
    return sum(values) / len(values) if values else None


def _foot_summary(stats: Any) -> Dict[str, Any]:
    return {
        "contact_count": int(stats.n_zero_runs),
        "mean_step_interval_s": (
            float(stats.mean_step_interval) if stats.mean_step_interval > 0 else None
        ),
        "mean_contact_duration_s": (
            float(stats.mean_contact_duration_s)
            if stats.mean_contact_duration_s > 0
            else None
        ),
    }


def _cadence_result(calculator_id: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    if calculator_id == "tkeo-cadence":
        from app.services.calculators.tkeo_cadence_calculator import TkeoCadenceCalculator

        calculator = TkeoCadenceCalculator()
    else:
        from app.services.calculators.step_cadence_calculator import StepCadenceCalculator

        calculator = StepCadenceCalculator()

    result = calculator.calculate(rows)
    contacts = []
    for sensor, foot in SENSOR_TO_FOOT.items():
        events = calculator._viz_data.get(sensor, {}).get("contact_events", [])
        for event in events:
            start_s = float(event["timestep_s"])
            duration_s = float(event["contact_time_s"])
            contacts.append(
                {
                    "foot": foot,
                    "start_time_s": start_s,
                    "end_time_s": start_s + duration_s,
                    "peak_time_s": start_s,
                    "duration_ms": duration_s * 1000.0,
                    "kind": "contact",
                    "confidence": (
                        float(event["confidence"])
                        if event.get("confidence") is not None
                        else None
                    ),
                }
            )

    contacts.sort(key=lambda contact: contact["start_time_s"])
    return {
        "calculator": calculator_id,
        "label": CALCULATOR_LABELS[calculator_id],
        "contacts": contacts,
        "summary": {
            "cadence_spm": float(result.cadence),
            "symmetry_index": float(result.symmetry_index),
            "gait_pattern": result.gait_pattern,
            "is_valid": bool(result.is_valid),
            "left": _foot_summary(result.left),
            "right": _foot_summary(result.right),
        },
    }


def _ttest_result(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    from app.services.calculators.step_detector_ttest import StepDetectorTTest

    steps = StepDetectorTTest().calculate(pd.DataFrame(rows))
    contacts = [
        {
            "foot": str(row.foot),
            "start_time_s": float(row.t_start),
            "end_time_s": float(row.t_end),
            "peak_time_s": float(row.t_peak),
            "duration_ms": float(row.contact_ms),
            "kind": str(row.kind),
            "confidence": float(row.peak_z),
        }
        for row in steps.itertuples(index=False)
    ]

    def summary_for(foot: str) -> Dict[str, Any]:
        foot_rows = steps[steps["foot"] == foot]
        stride_s = [float(value) / 1000.0 for value in foot_rows["stride_ms"].dropna()]
        duration_s = [float(value) / 1000.0 for value in foot_rows["contact_ms"].dropna()]
        return {
            "contact_count": len(foot_rows),
            "mean_step_interval_s": _mean_or_none(stride_s),
            "mean_contact_duration_s": _mean_or_none(duration_s),
        }

    return {
        "calculator": "step-detector-ttest",
        "label": CALCULATOR_LABELS["step-detector-ttest"],
        "contacts": contacts,
        "summary": {
            "cadence_spm": None,
            "symmetry_index": None,
            "gait_pattern": None,
            "is_valid": None,
            "left": summary_for("left"),
            "right": summary_for("right"),
        },
    }


def _calculate(calculator_id: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    if calculator_id == "step-detector-ttest":
        return _ttest_result(rows)
    return _cadence_result(calculator_id, rows)


@app.get("/health")
def health() -> Dict[str, bool]:
    return {"ok": True}


@app.post("/calculate/{calculator_id}")
async def calculate(
    calculator_id: str,
    payload: Dict[str, Any] = Body(...),
) -> Dict[str, Any]:
    if calculator_id not in CALCULATOR_LABELS:
        raise HTTPException(status_code=404, detail="Unknown calculator")

    rows = payload.get("rows")
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=422, detail="Session rows are required")

    try:
        return await asyncio.to_thread(_calculate, calculator_id, rows)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
