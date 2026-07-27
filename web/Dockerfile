# --- build stage -----------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app

# Baked into the built JS bundle by Vite (see src/api.ts, src/mapSetup.ts).
# Changing these requires a rebuild, which is why they're build ARGs
# rather than runtime environment variables like API_UPSTREAM below.
ARG API_BASE_URL=/api
ARG MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty
ENV VITE_API_BASE_URL=$API_BASE_URL
ENV VITE_MAP_STYLE_URL=$MAP_STYLE_URL

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

# --- serve stage -------------------------------------------------------
FROM nginx:1.27-alpine

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
