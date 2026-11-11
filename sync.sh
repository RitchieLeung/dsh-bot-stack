#!/bin/sh
# 把 fork 的源码同步到 profile 里 pnpm 安装的那份。
#
# 为什么需要：profile 用 `file:` 目录依赖，pnpm 装的是**快照**，不是软链。
# （曾经用软链，结果 fork 目录里没有 node_modules，deep-view 等依赖解析失败，
#   DSCord 插件整块加载不了。）
#
# 用法：./sync.sh          同步
#      ./sync.sh --check  只显示差异
set -e
TARGET=/Users/ritchie_leung/.dsh/profiles/web/node_modules/dscord
if [ "$1" = "--check" ]; then
  diff -rq --exclude=.git --exclude=node_modules --exclude=sync.sh . "$TARGET" || true
  exit 0
fi
rsync -a --delete \
  --exclude='.git' --exclude='node_modules' --exclude='sync.sh' \
  ./ "$TARGET/"
echo "已同步到 $TARGET（重启 dsh web 生效）"
