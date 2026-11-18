FROM node:26-slim AS build
RUN npm install --global pnpm@11.28.11
WORKDIR /repo

# Install dependencies first, so source changes do not repeat this step.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@llm-rudder/gateway..."

COPY packages/shared packages/shared
COPY apps/gateway apps/gateway
RUN pnpm --filter "@llm-rudder/gateway..." build
RUN pnpm --filter @llm-rudder/gateway deploy --legacy --prod /out

FROM node:26-slim
ENV NODE_ENV=production
ENV LLMR_CONFIG=/app/config/config.yaml
ENV LLMR_STATE_DIR=/state
WORKDIR /app
COPY --from=build /out ./
# The only writable path that survives an update. It holds the ChatGPT sign-in.
RUN mkdir -p /state && chown node:node /state && chmod 700 /state
USER node
EXPOSE 4141
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4141/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/main.js"]
