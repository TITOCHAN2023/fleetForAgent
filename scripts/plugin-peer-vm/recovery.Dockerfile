FROM node:22-bookworm-slim
WORKDIR /runtime
COPY packages/fleet-worker/package.json packages/fleet-worker/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
ENV WRANGLER_SEND_METRICS=false CI=true HOME=/tmp
CMD ["node", "-e", "setInterval(() => {}, 1000)"]
