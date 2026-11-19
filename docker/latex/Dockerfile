# LaTeX compiler for Grafito (docker/latex/server.py). TeX Live from Debian with the common
# packages and Spanish support; no network access is needed at compile time.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra \
      texlive-fonts-recommended texlive-lang-spanish texlive-science \
      lmodern \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/*

RUN useradd --system --create-home tex
USER tex
WORKDIR /home/tex
COPY --chown=tex server.py /home/tex/server.py

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')"
CMD ["python3", "/home/tex/server.py"]
