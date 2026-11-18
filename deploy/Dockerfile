FROM node:26-slim AS build
RUN npm install --global pnpm@11.28.11
WORKDIR /repo

# Install dependencies first, so source changes do not repeat this step.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@llm-router/gateway..."

COPY packages/shared packages/shared
COPY apps/gateway apps/gateway
RUN pnpm --filter "@llm-router/gateway..." build
RUN pnpm --filter @llm-router/gateway deploy --legacy --prod /out

FROM node:26-slim
ENV NODE_ENV=production
ENV LLMR_CONFIG=/app/config/config.yaml
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 4141
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4141/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/main.js"]
