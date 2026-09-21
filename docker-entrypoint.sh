#!/bin/sh
# location-svc shares this container. Render's PORT belongs to the API,
# so the geo process always listens on 8090 (LOCATION_SVC_URL).
set -eu
PORT=8090 /usr/local/bin/location-svc &
exec node dist/src/main.js
