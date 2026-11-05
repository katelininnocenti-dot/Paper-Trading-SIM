FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV HOST=0.0.0.0
# Render sets PORT. The process falls back to 8787 when PORT is unset.
EXPOSE 8787
CMD ["node", "server.js"]
