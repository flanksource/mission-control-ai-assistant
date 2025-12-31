# Build stage
FROM oven/bun:1 AS builder
WORKDIR /app

# Copy package files and install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Compile to standalone executable
RUN bun build --compile --minify --sourcemap src/index.ts --outfile slack-bot

# Runtime stage - minimal image
FROM debian:12-slim AS release
WORKDIR /app

# Copy only the compiled binary
COPY --from=builder /app/slack-bot /app/slack-bot

# Create non-root user
RUN useradd -r -s /bin/false appuser && \
    chown -R appuser:appuser /app

USER appuser
ENTRYPOINT ["/app/slack-bot"]
