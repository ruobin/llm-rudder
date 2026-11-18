FROM node:26-slim AS build
RUN npm install --global pnpm@11.28.11
WORKDIR /repo

# Install dependencies first, so source changes do not repeat this step.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile --filter "@llm-rudder/dashboard..."

COPY apps/dashboard apps/dashboard
RUN pnpm --filter @llm-rudder/dashboard build

FROM node:26-slim
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /repo/apps/dashboard/.next/standalone ./
COPY --from=build /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
RUN mkdir -p apps/dashboard/.next/cache && chown -R node:node apps/dashboard/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "apps/dashboard/server.js"]
