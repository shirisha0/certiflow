FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN mkdir -p /app/storage/certificates

EXPOSE 4000

CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
