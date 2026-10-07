FROM node:18-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:18-alpine AS builder
WORKDIR /app

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

ARG NEXT_PUBLIC_OPENCLAW_URL
ENV NEXT_PUBLIC_OPENCLAW_URL=$NEXT_PUBLIC_OPENCLAW_URL

ARG NEXT_PUBLIC_OPENCLAW_GATEWAY_URL
ENV NEXT_PUBLIC_OPENCLAW_GATEWAY_URL=$NEXT_PUBLIC_OPENCLAW_GATEWAY_URL

ARG NEXT_PUBLIC_OPENCLAW_GATEWAY_TOKEN=1
ENV NEXT_PUBLIC_OPENCLAW_GATEWAY_TOKEN=$NEXT_PUBLIC_OPENCLAW_GATEWAY_TOKEN

ARG NEXT_PUBLIC_CONFIG_API_URL
ENV NEXT_PUBLIC_CONFIG_API_URL=$NEXT_PUBLIC_CONFIG_API_URL

ARG NEXT_PUBLIC_AUTH_URL=https://auth.mawadao.com
ENV NEXT_PUBLIC_AUTH_URL=$NEXT_PUBLIC_AUTH_URL

ARG NEXT_PUBLIC_ROOT_DOMAIN=mawadao.com
ENV NEXT_PUBLIC_ROOT_DOMAIN=$NEXT_PUBLIC_ROOT_DOMAIN

ARG NEXT_PUBLIC_MEMBER_SPACE_URL=https://agent.mawadao.com
ENV NEXT_PUBLIC_MEMBER_SPACE_URL=$NEXT_PUBLIC_MEMBER_SPACE_URL

ARG NEXT_PUBLIC_CLOUD_MODE=true
ENV NEXT_PUBLIC_CLOUD_MODE=$NEXT_PUBLIC_CLOUD_MODE

ARG JWT_SECRET
ENV JWT_SECRET=$JWT_SECRET

ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL

ARG OPENROUTER_API_KEY
ENV OPENROUTER_API_KEY=$OPENROUTER_API_KEY

ARG JWT_ISSUER=mawadao-auth
ENV JWT_ISSUER=$JWT_ISSUER

COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Ensure public dir exists even if the project has none yet
RUN mkdir -p /app/public
RUN npm run build && npm prune --omit=dev

FROM node:18-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# Port 3001 is the tenant dashboard port; Cloud Run overrides via PORT env var
ENV PORT=3001

# Install Lightpanda headless browser for marketplace import pre-scraping
# Lightpanda requires glibc (not musl), hence node:18-slim instead of alpine
# Runtime deps: libcurl for HTTP loader, libglib for internals, curl for scraping fallback
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates libcurl4 libglib2.0-0 \
    && curl -L -o /usr/local/bin/lightpanda \
       https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-linux \
    && chmod +x /usr/local/bin/lightpanda \
    && rm -rf /var/lib/apt/lists/*
ENV LIGHTPANDA_BIN=/usr/local/bin/lightpanda

RUN groupadd -g 1001 nodejs \
    && useradd -u 1001 -g nodejs -m nextjs

COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3001
CMD ["sh", "-c", "npm start -- -p ${PORT:-3001}"]
