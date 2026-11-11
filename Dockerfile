# Uma imagem para os três serviços; o comando de início define o papel:
#   web: npm run start   |   worker: npm run worker   |   mcp-demo: npm run mcp-demo
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
