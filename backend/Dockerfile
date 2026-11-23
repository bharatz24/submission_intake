# syntax=docker/dockerfile:1
# Production image of the API. Build from backend/:  docker build -t submission-review-api backend

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
ENV NODE_ENV=production \
    PORT=3002
WORKDIR /app
# Runtime files only: compiled code, production dependencies, the shipped skills, rate workbooks and the OCR model
# (tesseract.js reads assets/ocr/eng.traineddata, OCR_DATA_PATH, instead of downloading it).
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node skills ./skills
COPY --chown=node:node data ./data
COPY --chown=node:node assets ./assets
# The eval baseline (and cases) behind Settings → Skills' eval status; no results are shipped.
COPY --chown=node:node evals/cases ./evals/cases
COPY --chown=node:node evals/README.md evals/baseline.json* ./evals/
USER node
EXPOSE 3002
# Liveness only (the process answers); the orchestrator's readiness check should use /api/ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
