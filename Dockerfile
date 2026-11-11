FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_OPTIONS="--max-old-space-size=256"

# Install lightweight runtime tools (tar/gzip for Supabase session archive sync + CA certs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    tar \
    gzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests first for fast cached layer builds
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy source code and frontend assets
COPY . .

# Ensure WhatsApp auth session directory exists
RUN mkdir -p /app/.wwebjs_auth && chmod -R 777 /app/.wwebjs_auth

EXPOSE 3000

CMD ["node", "src/server.js"]
