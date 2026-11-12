# TMIP api image — Phase 9 (docs/plans/001-first-vertical-slice.md)
# Multi-stage: deps -> build -> runner. Node slim base (alpine) with ffmpeg
# installed in the runtime stage (provides both ffmpeg and ffprobe).

# ---- deps: install workspace dependencies for @tmip/api --------------------
FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @tmip/api

# ---- build: compile TypeScript and generate the Prisma client --------------
# (Prisma generate runs inside the alpine stage so the musl query engine
# binary is downloaded for this platform.)
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api/ apps/api/
RUN pnpm --filter @tmip/api exec prisma generate \
  && pnpm --filter @tmip/api build

# ---- runner: minimal runtime image with ffmpeg/ffprobe ---------------------
FROM node:22-alpine AS runner
RUN apk add --no-cache ffmpeg \
  && addgroup -S tmip \
  && adduser -S tmip -G tmip
ENV NODE_ENV=production
# ffprobe location inside this image. MEDIA_ROOT and DATABASE_URL are set by
# docker-compose.yml so the image stays environment-agnostic.
ENV FFPROBE_PATH=/usr/bin/ffprobe
WORKDIR /app
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
USER tmip
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/server.js"]
