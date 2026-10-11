FROM golang:1.24.8-bookworm AS build
ENV GOMAXPROCS=2 GOGC=50
WORKDIR /src
# Official community release source. Image tags for older community binaries are no longer reliable.
RUN git init && git remote add origin https://github.com/minio/minio.git && git fetch --depth=1 origin 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a && git checkout --detach FETCH_HEAD
RUN CGO_ENABLED=0 go build -p 1 -trimpath -o /minio .
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home minio && mkdir /data && chown minio:minio /data
COPY --from=build /minio /usr/local/bin/minio
COPY --from=build /src/LICENSE /usr/share/licenses/minio/LICENSE
LABEL org.opencontainers.image.source="https://github.com/minio/minio" org.opencontainers.image.revision="9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a"
USER minio
HEALTHCHECK --interval=10s --timeout=3s --retries=15 CMD curl -f http://localhost:9000/minio/health/live || exit 1
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
