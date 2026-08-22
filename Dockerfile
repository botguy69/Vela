FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY migrations ./migrations
COPY public ./public
COPY scripts ./scripts
COPY server ./server
COPY src ./src
COPY tsconfig.json vite.config.ts eslint.config.mjs ./

ENV NITRO_PRESET=node-server
ENV VELA_WORKER=1
RUN npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 10000
CMD ["node", ".output/server/index.mjs"]
