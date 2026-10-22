FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Mount point for the SQLite database (see DB_PATH in the root docker-compose.yml).
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "dist/index.js"]
