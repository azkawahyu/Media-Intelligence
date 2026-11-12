# TMIP web image — Phase 9 (docs/plans/001-first-vertical-slice.md)
# Multi-stage build producing the Next.js standalone server.
# NOTE: NEXT_PUBLIC_API_URL is inlined into the browser bundle at build time.
# Changing it requires rebuilding the image (documented in .env.example).

# ---- deps: install workspace dependencies for @tmip/web --------------------
FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @tmip/web

# ---- build: produce the standalone Next.js output --------------------------
FROM deps AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
# Enable the standalone output defined in next.config.ts (Linux build container
# supports the symlinks standalone tracing requires).
ENV NEXT_OUTPUT=standalone
COPY tsconfig.base.json ./
COPY apps/web/ apps/web/
RUN pnpm --filter @tmip/web build

# ---- runner: standalone server ---------------------------------------------
FROM node:22-alpine AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
RUN addgroup -S tmip \
  && adduser -S tmip -G tmip
WORKDIR /app
# The standalone output is self-contained (its own minimal node_modules).
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER tmip
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
