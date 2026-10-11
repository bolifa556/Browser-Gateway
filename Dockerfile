FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 AS codec-build
USER root
RUN for file in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do \
      if [ -f "$file" ]; then sed -i 's#http://azure.archive.ubuntu.com/ubuntu#http://mirrors.ustc.edu.cn/ubuntu#g; s#http://security.ubuntu.com/ubuntu#http://mirrors.ustc.edu.cn/ubuntu#g' "$file"; fi; \
    done
RUN apt-get update && apt-get install -y --no-install-recommends clang lld libx11-dev libxcomposite-dev libxdamage-dev libxext-dev libxfixes-dev libxdo-dev \
    && rm -rf /var/lib/apt/lists/*
COPY codec/qoi.c /build/qoi.c
COPY codec/capture.cpp /build/capture.cpp
COPY codec/native-input.cpp /build/native-input.cpp
RUN clang --target=wasm32 -O3 -msimd128 -nostdlib -ffreestanding -fno-builtin \
    -Wl,--no-entry -Wl,--export-all -Wl,--export-memory \
    -Wl,--initial-memory=1048576 -Wl,--max-memory=536870912 \
    -o /build/qoi.wasm /build/qoi.c
RUN clang++ -std=c++17 -O3 -march=x86-64-v3 -pthread /build/capture.cpp -lX11 -lXcomposite -lXdamage -lXext -lXfixes -o /build/capture
RUN clang++ -std=c++17 -O2 /build/native-input.cpp -lX11 -lxdo -o /build/native-input

FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
USER root
RUN for file in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do \
      if [ -f "$file" ]; then sed -i 's#http://azure.archive.ubuntu.com/ubuntu#http://mirrors.ustc.edu.cn/ubuntu#g; s#http://security.ubuntu.com/ubuntu#http://mirrors.ustc.edu.cn/ubuntu#g' "$file"; fi; \
    done
RUN --mount=type=bind,source=vendor/chrome.deb,target=/tmp/google-chrome-stable.deb \
    echo 'c58aa0f2cd66179c9f050e062c882d27aa9b9f8c2b7c73fee3498560b5ed0b38  /tmp/google-chrome-stable.deb' | sha256sum -c - \
    && apt-get update && apt-get install -y --no-install-recommends openbox fonts-noto-core fonts-noto-cjk curl openssl libxcomposite1 libxdamage1 libxdo3 /tmp/google-chrome-stable.deb \
    && rm -rf /var/lib/apt/lists/* /ms-playwright
LABEL org.opencontainers.image.title="gpt-web" org.opencontainers.image.version="1.3.9"
COPY src/fontconfig.xml /etc/fonts/conf.d/99-gpt-web.conf
RUN fc-cache -f
RUN groupadd --gid 1007 gptweb && useradd --uid 1007 --gid 1007 --home-dir /app/data/home --no-create-home gptweb
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev --no-audit --no-fund --cache /tmp/gpt-build-npm-cache \
    && rm -rf /tmp/gpt-build-npm-cache
COPY --chown=1007:1007 src /app/src
COPY --chown=1007:1007 public /app/public
COPY --chown=1007:1007 tests /app/tests
COPY --chown=1007:1007 package.json /app/package.json
COPY --from=codec-build /build/qoi.wasm /app/public/qoi.wasm
COPY --from=codec-build /build/capture /app/capture
COPY --from=codec-build /build/native-input /app/native-input
COPY codec/LICENSE /app/public/QOI-LICENSE.txt
COPY vendor/acme.sh /app/vendor/acme.sh
USER 1007:1007
EXPOSE 3003/tcp
CMD ["flock", "--no-fork", "-n", "/app/data/.service.lock", "node", "src/start.js"]
