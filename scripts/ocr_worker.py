"""Local-only CPU OCR JSONL worker. Images never leave memory or reach a network API.

The pinned ddddocr 1.5.6 returns a T x C probability matrix, NOT a decoded
character list. set_ranges includes a blank at an arbitrary index and retains
original probabilities without renormalizing its selected columns. Decode CTC
by merging adjacent labels and then removing blanks; do not merge across blanks.
Confidence is the geometric mean of each emitted run's peak posterior, and
minConfidence is its weakest run. These model scores are not calibrated accuracy.
"""
import base64
import contextlib
import io
import json
import math
import re
import sys

MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_LINE_BYTES = 4 * ((MAX_IMAGE_BYTES + 2) // 3) + 4096
ALNUM = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"


def decode_ctc(result):
    if not isinstance(result, dict):
        raise ValueError("invalid_probability_shape")
    chars, rows = result.get("charsets"), result.get("probability")
    if (not isinstance(chars, list) or not isinstance(rows, list)
            or "" not in chars or len(set(chars)) != len(chars)
            or not 1 <= len(rows) <= 4096):
        raise ValueError("invalid_probability_shape")
    text, peaks, previous = [], [], None
    for row in rows:
        if (not isinstance(row, list) or len(row) != len(chars)
                or any(not isinstance(p, (int, float)) or not math.isfinite(p)
                       or p < 0 or p > 1.000001 for p in row)):
            raise ValueError("invalid_probability_shape")
        index = max(range(len(row)), key=row.__getitem__)
        symbol, confidence = chars[index], min(1.0, row[index])
        if symbol and symbol != previous:
            text.append(symbol)
            peaks.append(confidence)
        elif symbol and peaks:
            peaks[-1] = max(peaks[-1], confidence)
        previous = symbol
    if len(text) > 32:
        raise ValueError("text_too_long")
    return {
        "text": "".join(text),
        "confidence": math.exp(sum(math.log(max(p, 1e-12)) for p in peaks) / len(peaks)) if peaks else 0.0,
        "minConfidence": min(peaks) if peaks else 0.0,
    }


def normalize_charset(value):
    if value is None or value == "alnum":
        return ALNUM
    if value == "digits":
        return "0123456789"
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9]{1,128}", value):
        raise ValueError("invalid_charset")
    return "".join(dict.fromkeys(value))


def load_engine():
    from importlib.metadata import version
    import ddddocr
    from PIL import Image
    if version("ddddocr") != "1.5.6" or version("onnxruntime") != "1.20.1":
        raise RuntimeError("unsupported_dependency_version")
    # ddddocr 1.5.6 uses this old spelling; Pillow >=10 renamed the same filter.
    if not hasattr(Image, "ANTIALIAS"):
        Image.ANTIALIAS = Image.Resampling.LANCZOS
    Image.MAX_IMAGE_PIXELS = 2_000_000
    engine = ddddocr.DdddOcr(show_ad=False, use_gpu=False, det=False, ocr=True)
    if engine._DdddOcr__ort_session.get_providers() != ["CPUExecutionProvider"]:
        raise RuntimeError("cpu_provider_required")
    return engine, Image


def recognize_request(engine, image_module, request):
    if not isinstance(request, dict) or not isinstance(request.get("imageBase64"), str):
        raise ValueError("invalid_request")
    encoded = request["imageBase64"]
    if len(encoded) > 4 * ((MAX_IMAGE_BYTES + 2) // 3):
        raise ValueError("image_too_large")
    image_bytes = base64.b64decode(encoded, validate=True)
    if not 1 <= len(image_bytes) <= MAX_IMAGE_BYTES:
        raise ValueError("image_too_large")
    charset = normalize_charset(request.get("charset"))
    with image_module.open(io.BytesIO(image_bytes)) as image:
        if image.format not in ("PNG", "JPEG", "GIF", "BMP", "WEBP"):
            raise ValueError("unsupported_image")
        width, height = image.size
        # The model rescales height to 64. Bound the resulting tensor width too,
        # so a tiny 2048x1 strip cannot expand into an enormous inference tensor.
        if (not 1 <= width <= 2048 or not 1 <= height <= 2048
                or width * height > 2_000_000 or width * 64 / height > 2048):
            raise ValueError("invalid_image_dimensions")
        image.verify()
    engine.set_ranges(charset)
    result = decode_ctc(engine.classification(image_bytes, probability=True, png_fix=True))
    if any(char not in charset for char in result["text"]):
        raise ValueError("invalid_recognition")
    return result


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


def main():
    try:
        with contextlib.redirect_stdout(sys.stderr):
            engine, image_module = load_engine()
    except Exception:
        sys.stderr.write("Local OCR initialization failed.\n")
        return 78
    capability = {"available": True, "engine": "ddddocr", "version": "1.5.6", "runtimeVersion": "1.20.1", "provider": "CPUExecutionProvider", "python": sys.version.split()[0]}
    if "--check" in sys.argv:
        emit(capability)
        return 0
    emit({"ready": True, **capability})
    while True:
        raw = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not raw:
            return 0
        # Reject and terminate a malformed oversized stream rather than buffering it.
        if len(raw) > MAX_LINE_BYTES or not raw.endswith(b"\n"):
            return 65
        request_id = None
        try:
            request = json.loads(raw)
            request_id = request.get("id") if isinstance(request, dict) else None
            if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", request_id):
                raise ValueError("invalid_id")
            with contextlib.redirect_stdout(sys.stderr):
                result = recognize_request(engine, image_module, request)
            emit({"id": request_id, **result})
        except Exception:
            # Do not echo raw images, server-provided strings, paths, or tracebacks.
            emit({"id": request_id, "error": "recognition_failed"})


if __name__ == "__main__":
    raise SystemExit(main())
