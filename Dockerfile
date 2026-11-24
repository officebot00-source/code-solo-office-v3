# Root-level copy so Render works even with its default settings (Dockerfile Path ./Dockerfile, Context .).
# Keep in sync with video-editor-service/Dockerfile. Build from the repository ROOT: docker build -t video-editor .
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY src/lib/app/video.ts src/lib/app/gameVideo.ts src/lib/app/
COPY video-editor-service/hooks.mjs video-editor-service/register.mjs video-editor-service/
COPY video-editor-service/server.mjs video-editor-service/server.mjs
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "--import", "./video-editor-service/register.mjs", "video-editor-service/server.mjs"]
