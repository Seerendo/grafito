"""OCR for Grafito.

POST /ocr?lang=spa+eng with a PDF or an image (PNG, JPEG, TIFF) as the body returns JSON
{"pages": ["text of page 1", ...]}. PDFs go through OCRmyPDF, which only recognizes pages
without a text layer; images go straight to Tesseract. Limits on size, pages and time keep one
document from taking the service over.
"""

import json
import os
import shutil
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MAX_BYTES = int(os.environ.get("OCR_MAX_MB", "100")) * 1024 * 1024
MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "300"))
TIMEOUT = int(os.environ.get("OCR_TIMEOUT_SECONDS", "900"))
LANGS = {"spa", "eng"}


def run(args: list[str], cwd: str) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=cwd, capture_output=True, timeout=TIMEOUT)


def page_count(path: str, cwd: str) -> int:
    done = run(["pdfinfo", path], cwd)
    for line in done.stdout.decode("utf-8", "replace").splitlines():
        if line.startswith("Pages:"):
            return int(line.split()[1])
    return 0


def ocr_pdf(data: bytes, lang: str) -> list[str]:
    work = tempfile.mkdtemp(prefix="ocr-")
    try:
        source = os.path.join(work, "in.pdf")
        with open(source, "wb") as handle:
            handle.write(data)
        pages = page_count(source, work)
        if pages > MAX_PAGES:
            # Only the first pages: the rest of a huge scan waits for nobody.
            run(["qpdf", source, "--pages", source, f"1-{MAX_PAGES}", "--", os.path.join(work, "cut.pdf")], work)
            source = os.path.join(work, "cut.pdf")
        sidecar = os.path.join(work, "out.txt")
        done = run(
            [
                "ocrmypdf",
                "--skip-text",
                "--language", lang,
                "--sidecar", sidecar,
                "--output-type", "pdf",
                "--jobs", os.environ.get("OCR_JOBS", "2"),
                source,
                os.path.join(work, "out.pdf"),
            ],
            work,
        )
        if done.returncode not in (0, 6):  # 6: the PDF already had text.
            raise RuntimeError(done.stderr.decode("utf-8", "replace")[-500:])
        if not os.path.exists(sidecar):
            return []
        with open(sidecar, encoding="utf-8", errors="replace") as handle:
            return [page.strip() for page in handle.read().split("\f")]
    finally:
        shutil.rmtree(work, ignore_errors=True)


def ocr_image(data: bytes, lang: str) -> list[str]:
    work = tempfile.mkdtemp(prefix="ocr-")
    try:
        source = os.path.join(work, "in.img")
        with open(source, "wb") as handle:
            handle.write(data)
        done = run(["tesseract", source, "stdout", "-l", lang], work)
        if done.returncode != 0:
            raise RuntimeError(done.stderr.decode("utf-8", "replace")[-500:])
        return [done.stdout.decode("utf-8", "replace").strip()]
    finally:
        shutil.rmtree(work, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        self._json(200 if self.path == "/health" else 404, {"ok": self.path == "/health"})

    def do_POST(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        if url.path != "/ocr":
            self._json(404, {"error": "No existe."})
            return
        langs = [part for part in parse_qs(url.query).get("lang", ["spa+eng"])[0].split("+") if part in LANGS]
        lang = "+".join(langs) or "spa+eng"
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BYTES:
            self._json(413, {"error": "El archivo es demasiado grande para el OCR."})
            return
        data = self.rfile.read(length)
        try:
            pages = ocr_pdf(data, lang) if data[:5] == b"%PDF-" else ocr_image(data, lang)
            self._json(200, {"pages": pages})
        except subprocess.TimeoutExpired:
            self._json(504, {"error": f"El OCR pasó de {TIMEOUT} segundos."})
        except Exception as error:  # noqa: BLE001 - any tool failure becomes a readable answer
            self._json(422, {"error": str(error)[:500]})

    def log_message(self, *_args) -> None:
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
