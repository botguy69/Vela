FROM node:22-bookworm-slim
WORKDIR /app

# Playwright is a devDep; don't download browsers during image build.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PUPPETEER_SKIP_DOWNLOAD=1
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false
# Render injects NODE_ENV=production at build; that skips vite (a devDep).
ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm install --include=dev --no-audit --no-fund

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
