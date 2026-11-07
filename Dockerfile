# 1. Base 이미지: Node.js 24 Debian Bookworm Slim
FROM node:24-bookworm-slim

# 작업 디렉터리
WORKDIR /app

# 시스템 의존성 설치 (네이티브 모듈 빌드용 C++ 도구, Python, FFmpeg, CA 인증서)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# PM2 전역 설치 (컨테이너 PID 1로 포그라운드 실행을 지원하는 pm2-runtime 제공)
RUN npm install -g pm2

# 의존성 파일 복사
COPY package.json package-lock.json ./

# 패키지 클린 설치
RUN npm ci

# 전체 소스 코드 복사
COPY . .

# 대시보드 웹 포트 개방
EXPOSE 13000

# 헬스체크 정의
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:13000/health || exit 1

# PM2 런타임으로 ecosystem.config.cjs 실행 (Docker PID 1 유지 및 프로세스 자동 복구)
CMD ["pm2-runtime", "ecosystem.config.cjs"]
