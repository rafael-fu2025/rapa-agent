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

# Copy built frontend
COPY --from=frontend-builder /app/dist ./dist

# Copy built backend
COPY --from=backend-builder /app/server/dist ./server/dist

# Ensure the app runs in production mode
ENV NODE_ENV=production
ENV PORT=8787

# Create a startup script to run migrations and start the server
RUN echo '#!/bin/sh' > /app/start.sh && \
    echo 'cd /app/server' >> /app/start.sh && \
    echo 'npx prisma migrate deploy' >> /app/start.sh && \
    echo 'node dist/index.js' >> /app/start.sh && \
    chmod +x /app/start.sh

EXPOSE 8787

CMD ["/app/start.sh"]
