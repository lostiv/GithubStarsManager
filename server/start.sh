#!/bin/sh
# 修复 bind mount 目录权限后切换到 node 用户运行
chown node:node /app/data 2>/dev/null || true
exec su-exec node node dist/index.js
