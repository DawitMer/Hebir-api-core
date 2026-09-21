# syntax=docker/dockerfile:1

FROM golang:1.27.1-alpine AS location
WORKDIR /src
RUN apk add --no-cache git ca-certificates
COPY location-sidecar/go.mod location-sidecar/go.sum ./
RUN go mod download
COPY location-sidecar/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/location-svc .

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
COPY --from=location /out/location-svc /usr/local/bin/location-svc
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh /usr/local/bin/location-svc
USER hebir
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/readyz >/dev/null || exit 1
CMD ["docker-entrypoint.sh"]
