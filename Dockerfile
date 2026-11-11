FROM node:24-alpine
WORKDIR /app
COPY server.js oracle.js ./
COPY public ./public
COPY data ./data
ENV PORT=8080
EXPOSE 8080
USER node
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "server.js"]
