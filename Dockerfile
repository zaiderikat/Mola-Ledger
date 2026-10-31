FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY server ./server
RUN mkdir -p /data && chown node:node /data
USER node
ENV MOLA_LEDGER_HOST=0.0.0.0 MOLA_LEDGER_PORT=8787 MOLA_LEDGER_DB_PATH=/data/effects.sqlite
EXPOSE 8787
CMD ["node", "server/cli.mjs"]
