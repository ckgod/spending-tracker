# spending-tracker — Node + better-sqlite3 (linux/amd64)
FROM node:20-bookworm-slim

WORKDIR /app
ENV TZ=Asia/Seoul \
    NODE_ENV=production \
    DATA_DIR=/data \
    BIND_ADDR=0.0.0.0 \
    PORT=8080

# better-sqlite3는 보통 prebuilt 바이너리를 받지만, 못 받을 때를 대비해
# 빌드도구를 임시 설치해 npm ci 한 뒤 제거(이미지 슬림 유지).
COPY server/package*.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# 애플리케이션 코드(index.js·parse.js·public/). 데이터·시크릿은 /data 볼륨으로 분리.
COPY server/ ./

EXPOSE 8080
CMD ["node", "--max-old-space-size=128", "index.js"]
