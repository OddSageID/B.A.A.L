FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src ./src
COPY bin ./bin
COPY db ./db
COPY schemas ./schemas

ENV NODE_ENV=production \
    BAAL_HEALTH_HOST=0.0.0.0

USER node
EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1

CMD ["node", "index.js"]
