FROM node:22-bookworm-slim
RUN useradd --system --create-home --shell /usr/sbin/nologin zyron
WORKDIR /opt/zyron
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY dist ./dist
USER zyron
ENV NODE_ENV=production
# No keystore, password, or node identity is copied into the image.
# /var/lib/zyron is a volume so the signing journal and node identity survive recreate.
VOLUME ["/var/lib/zyron"]
# Consensus and signer ports are not published. The public role is reached through the reverse proxy.
CMD ["node", "dist/src/secure-cli.js"]
