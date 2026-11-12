# Grafeno, the graph engine behind Grafito's graph and mentions (the `grafeno`
# service in docker-compose.yml). The official static Linux build of a release,
# checked against the checksums pinned here: changing GRAFENO_VERSION means
# changing both sums as well (the .sha256 files of that release).

FROM alpine:3.20

ARG GRAFENO_VERSION=0.2.1
ARG GRAFENO_SHA256_AMD64=376a40a9217e71f9b4780ddd4d0b8b16e9db50bf3088fdb218a6eb9b35cd31b0
ARG GRAFENO_SHA256_ARM64=e7af3656a058e588d9ce6ca4202de4c5beabe85bdd7389386f35b5c2de7d5f36
ARG TARGETARCH

RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x86_64; sum="$GRAFENO_SHA256_AMD64" ;; \
      arm64) arch=aarch64; sum="$GRAFENO_SHA256_ARM64" ;; \
      *) echo "Grafeno has no build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    file="grafeno-${arch}-unknown-linux-musl.tar.gz"; \
    wget -q -O "/tmp/${file}" \
      "https://github.com/grafenodb/grafeno/releases/download/v${GRAFENO_VERSION}/${file}"; \
    echo "${sum}  /tmp/${file}" | sha256sum -c -; \
    mkdir /tmp/grafeno; \
    tar -xzf "/tmp/${file}" -C /tmp/grafeno; \
    install -m 0755 /tmp/grafeno/grafeno /usr/local/bin/grafeno; \
    rm -rf /tmp/grafeno "/tmp/${file}"; \
    adduser -S -u 10001 -H grafeno; \
    mkdir /data; \
    chown grafeno /data

USER grafeno
ENV GRAFENO_DB=/data/grafeno.redb \
    GRAFENO_ADDR=0.0.0.0:7810
VOLUME /data
EXPOSE 7810
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:7810/health || exit 1
ENTRYPOINT ["grafeno"]
CMD ["serve"]
