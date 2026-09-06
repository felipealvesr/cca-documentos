"""Offline NDJSON worker. Images and text stay in memory; stdout is protocol only."""
import base64
import json
import logging
import os
from pathlib import Path
import socket
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")
logging.disable(logging.CRITICAL)

# Explicitly offline: no model download, telemetry or accidental remote image fetch.
def blocked_connection(*_args, **_kwargs):
    raise OSError("Network disabled in the CCA OCR worker")
socket.socket.connect = blocked_connection
socket.create_connection = blocked_connection

import cv2
import numpy as np
from rapidocr import RapidOCR
from rapidocr.utils.typings import OCRVersion, ModelType

ROOT = Path(__file__).resolve().parent
ENGINES = {}
cv2.setNumThreads(2)

def engine(tier):
    if tier not in ENGINES:
        params = {
            "Global.log_level": "critical",
            "Global.text_score": 0.30,
            "Global.max_side_len": 2400,
            "Global.use_cls": True,
            "EngineConfig.onnxruntime.intra_op_num_threads": 4,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
            "EngineConfig.onnxruntime.use_cuda": False,
            "Det.ocr_version": OCRVersion.PPOCRV6,
            "Det.model_type": ModelType(tier),
            "Det.model_path": str(ROOT / "models" / f"PP-OCRv6_det_{tier}.onnx"),
            "Det.limit_side_len": 960,
            "Det.limit_type": "max",
            "Rec.ocr_version": OCRVersion.PPOCRV6,
            "Rec.model_type": ModelType(tier),
            "Rec.model_path": str(ROOT / "models" / f"PP-OCRv6_rec_{tier}.onnx"),
            "Rec.rec_batch_num": 6,
            "Cls.model_path": str(ROOT / "models" / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"),
        }
        ENGINES[tier] = RapidOCR(params=params)
    return ENGINES[tier]

for line in sys.stdin:
    request_id = None
    try:
        request = json.loads(line)
        request_id = request.get("id")
        tier = request.get("model", "small")
        if tier not in ("small", "medium") or len(request.get("image", "")) > 45_000_000:
            raise ValueError("Invalid request")
        data = base64.b64decode(request["image"], validate=True)
        image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None or image.shape[0] * image.shape[1] > 60_000_000:
            raise ValueError("Invalid image")
        started = time.perf_counter()
        result = engine(tier)(image)
        blocks = []
        if result.boxes is not None:
            for polygon, text, confidence in zip(result.boxes, result.txts, result.scores):
                xs, ys = polygon[:, 0], polygon[:, 1]
                blocks.append({"text": str(text), "confidence": float(confidence), "page": request.get("page", 1), "box": {"x": float(xs.min()), "y": float(ys.min()), "width": float(xs.max() - xs.min()), "height": float(ys.max() - ys.min())}})
        response = {"id": request_id, "success": True, "blocks": blocks, "durationMs": round((time.perf_counter() - started) * 1000)}
    except Exception as error:
        response = {"id": request_id, "success": False, "errorCode": type(error).__name__}
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    sys.stdout.flush()
