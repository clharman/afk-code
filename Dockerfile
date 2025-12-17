FROM oven/bun:1.2
WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./

EXPOSE 8080
ENV NODE_ENV=production
CMD ["bun", "run", "src/relay/index.ts"]
