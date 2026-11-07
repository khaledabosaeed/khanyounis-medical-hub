FROM node:22-alpine

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY server ./server
COPY db ./db
COPY public ./public
COPY scripts ./scripts
RUN pnpm build

ENV NODE_ENV=production
ENV STATIC_DIR=/app/dist/public
EXPOSE 3000
CMD ["node", "server/index.js"]
