FROM node:22.19-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
ENV CLOUD_HOST=0.0.0.0 CLOUD_PORT=8787 CLOUD_DATA_DIR=/data
USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/cloud/main.ts"]
