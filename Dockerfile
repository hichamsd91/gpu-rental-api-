# Node 20 per RUNBOOK (Node 18 is end-of-life); npm ci below stays pinned to the lockfile.
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 5000

CMD ["node", "src/server.js"]
