# Multi-stage build for Rigo FM
FROM node:20-alpine AS base

# Install build tools for better-sqlite3 native compile + yt-dlp for YouTube search fallback
RUN apk add --no-cache python3 py3-pip make g++ sqlite ffmpeg curl \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp

WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source
COPY src ./src
COPY public ./public
COPY views ./views

# Create data dir and set ownership
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3002

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3002/health || exit 1

CMD ["node", "src/server.js"]
