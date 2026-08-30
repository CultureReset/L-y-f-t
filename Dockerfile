# The API. Runs TypeScript directly through tsx rather than building first —
# the source is the artifact in this repository, and a build step here would
# only add a way for the two to disagree.

FROM node:22-alpine

WORKDIR /app

# Install dependencies against the workspace manifests, so a source-only change
# reuses the cached layer.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/geo/package.json packages/geo/
COPY packages/sdk/package.json packages/sdk/
COPY packages/ui/package.json packages/ui/
COPY services/api/package.json services/api/
COPY tools/simulator/package.json tools/simulator/

# The apps are not part of the API image; ignore their workspaces.
RUN npm ci --legacy-peer-deps --omit=optional --workspaces --include-workspace-root \
      --workspace @lift/core \
      --workspace @lift/geo \
      --workspace @lift/sdk \
      --workspace @lift/api \
      --workspace @lift/simulator \
    || npm install --legacy-peer-deps

COPY tsconfig.base.json tsconfig.json ./
COPY packages/core packages/core
COPY packages/geo packages/geo
COPY packages/sdk packages/sdk
COPY services/api services/api
COPY tools/simulator tools/simulator

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s \
  CMD wget -qO- http://localhost:4000/health || exit 1

CMD ["npm", "run", "start", "-w", "@lift/api"]
