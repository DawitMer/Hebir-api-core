# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build \
  && npm prune --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
RUN apk add --no-cache wget \
  && addgroup -S hebir && adduser -S hebir -G hebir
COPY --from=build --chown=hebir:hebir /app/dist ./dist
COPY --from=build --chown=hebir:hebir /app/node_modules ./node_modules
COPY --from=build --chown=hebir:hebir /app/package.json ./
USER hebir
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/readyz >/dev/null || exit 1
CMD ["node", "dist/src/main.js"]
