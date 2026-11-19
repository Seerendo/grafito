# OCR for Grafito (docker/ocr/server.py): OCRmyPDF and Tesseract with Spanish and English.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 ocrmypdf tesseract-ocr tesseract-ocr-spa tesseract-ocr-eng poppler-utils qpdf \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/*

RUN useradd --system --create-home ocr
USER ocr
WORKDIR /home/ocr
COPY --chown=ocr server.py /home/ocr/server.py

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')"
CMD ["python3", "/home/ocr/server.py"]
