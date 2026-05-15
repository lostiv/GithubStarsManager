FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
RUN mkdir -p data && chown -R node:node /app && apk add --no-cache su-exec
COPY start.sh /start.sh
RUN chmod +x /start.sh
VOLUME /app/data
EXPOSE 3000
CMD ["/start.sh"]
