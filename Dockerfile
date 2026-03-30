FROM node:20-slim

RUN apt-get update && apt-get install -y \
    libssl3 zlib1g ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY src/ ./src/

ENV DATA_DIR=/app/data

CMD ["node", "src/runtime.mjs"]
