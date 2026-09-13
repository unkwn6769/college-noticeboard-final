FROM node:22-alpine

WORKDIR /app

COPY server/package*.json ./server/
RUN npm --prefix server ci --omit=dev --ignore-scripts

COPY server ./server

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["sh", "-c", "node server/preflight.js && node server/server.js"]
