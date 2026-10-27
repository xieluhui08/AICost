FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps \
    && npm cache clean --force
COPY server.mjs ledger.mjs coding.mjs telemetry.mjs integrations.mjs ./
COPY dist ./dist
RUN mkdir data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0
EXPOSE 8080
CMD ["node","server.mjs"]
