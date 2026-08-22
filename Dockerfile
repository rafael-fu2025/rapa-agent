# syntax=docker/dockerfile:1

# Stage 1: Build the frontend (Vite)
FROM node:20-alpine AS frontend-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Build the backend (Fastify + Prisma)
FROM node:20-alpine AS backend-builder
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/prisma ./prisma/
RUN npx prisma generate
COPY server/ ./
RUN npm run build

# Stage 3: Production Server
FROM node:20-alpine
WORKDIR /app

# Install production dependencies for the backend
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# Copy Prisma schema and generate client
COPY server/prisma ./server/prisma/
RUN cd server && npx prisma generate

# Copy built frontend.
# NOTE: vite.config.ts sets `outDir: web-dist`, and the server resolves the
# static root as `<repo root>/web-dist` (see src/index.ts). Copy to match.
COPY --from=frontend-builder /app/web-dist ./web-dist

# Copy built backend
COPY --from=backend-builder /app/server/dist ./server/dist

# Ensure the app runs in production mode
ENV NODE_ENV=production
ENV PORT=8787
# SQLite database, persisted via a volume mounted at /app/server/prisma/data.
# (schema.prisma uses provider = "sqlite"; switch the provider to mysql or
# postgresql in a build stage if you need a hosted multi-user database.)
ENV DATABASE_URL=file:./data/production.db

# Create a startup script to run migrations and start the server
RUN echo '#!/bin/sh' > /app/start.sh && \
    echo 'set -e' >> /app/start.sh && \
    echo 'cd /app/server' >> /app/start.sh && \
    echo 'mkdir -p prisma/data' >> /app/start.sh && \
    echo 'npx prisma migrate deploy' >> /app/start.sh && \
    echo 'node dist/index.js' >> /app/start.sh && \
    chmod +x /app/start.sh

EXPOSE 8787

CMD ["/app/start.sh"]
