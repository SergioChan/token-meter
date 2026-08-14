FROM node:22.12.0-bookworm-slim

ENV NODE_ENV=production \
    TOKEN_METER_REGISTRY_HOST=0.0.0.0 \
    TOKEN_METER_REGISTRY_PORT=8787

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY src ./src
COPY web ./web

USER 10001:10001

EXPOSE 8787

CMD ["node", "server/serve.mjs"]
