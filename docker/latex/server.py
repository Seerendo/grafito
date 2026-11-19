"""LaTeX compiler for Grafito.

POST /compile with the .tex source as the body (UTF-8) returns the PDF (200) or, when TeX
fails, a JSON {"error", "log"} (422). One compilation at a time per worker thread, in a fresh
folder, with pdflatex (or XeLaTeX, picked with `% !TEX program = xelatex`) in -no-shell-escape
mode, BibTeX or biber when the document has a bibliography, a time limit and a size limit. The service has
no access to Grafito's data: it only sees the source it is sent.
"""

import json
import re
import os
import shutil
import subprocess
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_SOURCE = 2 * 1024 * 1024
# Budget for the whole compilation (every pass, bibliography included).
TIMEOUT = int(os.environ.get("LATEX_TIMEOUT_SECONDS", "120"))
ENGINES = {"pdflatex": "pdflatex", "xelatex": "xelatex"}
SAFE_ENV = {**os.environ, "openout_any": "p", "openin_any": "p"}


def engine_of(source: bytes) -> str:
    """`% !TEX program = xelatex` in the first lines picks XeLaTeX; pdflatex otherwise."""
    head = source[:2000].decode("utf-8", "replace")
    match = re.search(r"^%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\w+)", head, re.I | re.M)
    return ENGINES.get(match.group(1).lower(), "pdflatex") if match else "pdflatex"


def bibliography_tool(work: str) -> list[str] | None:
    """biber when biblatex asked for it, bibtex when the document has \\bibliography{…}."""
    if os.path.exists(os.path.join(work, "documento.bcf")):
        return ["biber", "--quiet", "documento"]
    try:
        with open(os.path.join(work, "documento.aux"), encoding="utf-8", errors="replace") as handle:
            if "\\bibdata" in handle.read():
                return ["bibtex", "documento"]
    except OSError:
        pass
    return None


def compile_source(source: bytes) -> tuple[int, bytes, str]:
    work = tempfile.mkdtemp(prefix="tex-")
    deadline = time.monotonic() + TIMEOUT
    engine = engine_of(source)

    def run(command: list[str]) -> subprocess.CompletedProcess:
        left = deadline - time.monotonic()
        if left <= 0:
            raise subprocess.TimeoutExpired(command, TIMEOUT)
        return subprocess.run(command, cwd=work, capture_output=True, timeout=left, env=SAFE_ENV)

    def tex() -> subprocess.CompletedProcess:
        return run(
            [
                engine,
                "-no-shell-escape",
                "-interaction=nonstopmode",
                "-halt-on-error",
                "-file-line-error",
                "documento.tex",
            ]
        )

    try:
        with open(os.path.join(work, "documento.tex"), "wb") as handle:
            handle.write(source)
        done = tex()
        log = done.stdout.decode("utf-8", "replace")
        if done.returncode != 0:
            return 422, b"", log
        tool = bibliography_tool(work)
        if tool:
            bib = run(tool)
            if bib.returncode != 0:
                out = (bib.stdout + bib.stderr).decode("utf-8", "replace")
                return 422, b"", f"Bibliografía ({tool[0]}):\n{out}"
        # Again, so citations, references and the table of contents settle.
        for _ in range(2 if tool else 1):
            done = tex()
            log = done.stdout.decode("utf-8", "replace")
            if done.returncode != 0:
                return 422, b"", log
        with open(os.path.join(work, "documento.pdf"), "rb") as handle:
            return 200, handle.read(), log
    except subprocess.TimeoutExpired:
        return 422, b"", f"La compilación pasó de {TIMEOUT} segundos."
    finally:
        shutil.rmtree(work, ignore_errors=True)


def first_error(log: str) -> str:
    """The first TeX error line, which is what a person needs to fix."""
    lines = log.splitlines()
    # -file-line-error writes "./documento.tex:12: Undefined control sequence."
    for line in lines:
        match = re.match(r"^\./documento\.tex:(\d+): (.+)$", line)
        if match and "Fatal error occurred" not in match.group(2):
            return f"Línea {match.group(1)}: {match.group(2).strip()}"[:300]
    for line in lines:
        if line.startswith("!"):
            return line[1:].strip()[:300]
    if lines and lines[0].startswith("Bibliografía"):
        detail = next((l for l in lines[1:] if "ERROR" in l or "error" in l), "")
        return f"{lines[0].rstrip(':')}: {detail.strip()}"[:300] if detail else lines[0].rstrip(":")
    if lines and lines[0].startswith("La compilación pasó"):
        return lines[0]
    return "La compilación falló."


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, kind: str) -> None:
        self.send_response(status)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, b"ok", "text/plain")
        else:
            self._send(404, b"", "text/plain")

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/compile":
            self._send(404, b"", "text/plain")
            return
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_SOURCE:
            self._send(413, json.dumps({"error": "El documento es demasiado grande."}).encode(), "application/json")
            return
        status, pdf, log = compile_source(self.rfile.read(length))
        if status == 200:
            self._send(200, pdf, "application/pdf")
        else:
            body = json.dumps({"error": first_error(log), "log": log[-20000:]})
            self._send(422, body.encode(), "application/json")

    def log_message(self, *_args) -> None:
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
