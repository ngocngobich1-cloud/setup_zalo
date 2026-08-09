FROM node:24-slim

# Ghim dung phien ban dang chay tren may de khong lech hanh vi.
# Goi nay tu keo dung ban nhi phan cho kien truc cua may (linux x64 hoac arm64),
# nen dung duoc ca tren may ARM cua chi lan VPS amd64.
RUN npm install -g opencode-ai@1.18.4

# Key va cau hinh nam o hai thu muc nay -> phai mount volume, mat la mat key.
VOLUME ["/root/.config/opencode", "/root/.local/share/opencode"]

EXPOSE 4096
CMD ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
