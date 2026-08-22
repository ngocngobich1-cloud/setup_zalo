FROM node:24.18.0

# Cài đặt các công cụ biên dịch (python3, make, g++) cho sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy các file quản lý gói và cài đặt dependencies trước
COPY package.json package-lock.json ./
RUN npm ci

# Copy toàn bộ phần còn lại (đã bị lọc bởi .dockerignore)
COPY . .

EXPOSE 3790
CMD ["node", "server.js"]
