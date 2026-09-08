#!/bin/bash
# 推送到 GitHub：自动探测本机 v2rayN(xray) 的 HTTP 代理端口。
# 直连 GitHub 在本机网络下常被重置，而 v2rayN 每次启动端口随机，
# 因此推送前动态探测，不再依赖固定端口配置。
set -e
cd "$(dirname "$0")"

PORT=$(ss -tlnp 2>/dev/null | grep '"xray"' | grep -oE ':[0-9]+' | head -1 | tr -d ':')

if [ -n "$PORT" ] && curl -sS -o /dev/null --max-time 5 \
        -x "http://127.0.0.1:$PORT" https://api.github.com/zen; then
    echo "使用代理 127.0.0.1:$PORT"
    git -c http.proxy="http://127.0.0.1:$PORT" push origin master
else
    echo "未找到可用代理，尝试直连"
    git push origin master
fi
