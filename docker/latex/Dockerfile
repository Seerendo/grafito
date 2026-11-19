# LaTeX compiler for Grafito (docker/latex/server.py). TeX Live from Debian with Spanish
# support, bibliographies (BibTeX and biber), XeLaTeX and the usual package collections; no
# network access is needed at compile time.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 fontconfig \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra \
      texlive-fonts-recommended texlive-fonts-extra cm-super lmodern \
      texlive-lang-spanish texlive-lang-english texlive-lang-european \
      texlive-science texlive-pictures texlive-publishers texlive-humanities \
      texlive-bibtex-extra biber texlive-xetex texlive-plain-generic \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/*

# TeX Live's own OpenType/TrueType fonts, by name, for XeLaTeX (fontspec).
COPY 09-texlive.conf /etc/fonts/conf.d/09-texlive.conf
RUN fc-cache -f

RUN useradd --system --create-home tex
USER tex
WORKDIR /home/tex
COPY --chown=tex server.py /home/tex/server.py

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')"
CMD ["python3", "/home/tex/server.py"]
