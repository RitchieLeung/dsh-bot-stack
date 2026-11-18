#!/usr/bin/env bash
# 本机开发测试完成后，把同一份构建部署到 146。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help) echo "用法：npm run deploy:146 [-- --dry-run|--allow-dirty]"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

if [ "$DRY_RUN" = 1 ]; then
  cat <<'EOF'
dry-run：不会执行 git/npm/ssh/rsync/systemctl。
实际部署将依次执行：本机 check → pack → 上传 → 146 停服备份 → 安装 → 启动 → 健康检查。
可用环境变量：DEPLOY_HOST、REMOTE_ROOT、DSH_NODE_HOME、DSH_SERVICE、STACK_BUILD_ID。
EOF
  exit 0
fi

HOST="${DEPLOY_HOST:-146.56.202.108}"
REMOTE_ROOT="${REMOTE_ROOT:-/home/liangliqiang/dsh-bot-stack}"
NODE_HOME="${DSH_NODE_HOME:-/home/liangliqiang/.nvm/versions/node/v24.22.2}"
SERVICE="${DSH_SERVICE:-dsh-web.service}"

cd "$ROOT"
if [ "$ALLOW_DIRTY" != 1 ] && [ -n "$(git status --porcelain)" ]; then
  echo "git 工作区不干净。先提交，或显式使用 --allow-dirty。" >&2
  exit 1
fi

npm run check
npm run pack

BUILD_ID="$(node -e "const m=require('./dist/manifest.json');process.stdout.write(m.stack.buildId)")"
HEAD="$(node -e "const m=require('./dist/manifest.json');process.stdout.write(m.stack.head)")"
RELEASE_DIR="$REMOTE_ROOT/releases/$BUILD_ID"

echo "部署 $HEAD（build $BUILD_ID）到 $HOST"
ssh "$HOST" "mkdir -p '$RELEASE_DIR/scripts'"
rsync -az --delete "$ROOT/dist/" "$HOST:$RELEASE_DIR/dist/"
rsync -az "$ROOT/scripts/install.mjs" "$ROOT/scripts/remote-deploy.sh" "$HOST:$RELEASE_DIR/scripts/"

ssh "$HOST" "REMOTE_ROOT='$REMOTE_ROOT' DSH_NODE_HOME='$NODE_HOME' DSH_SERVICE='$SERVICE' bash '$RELEASE_DIR/scripts/remote-deploy.sh' --release-dir '$RELEASE_DIR'"
echo "部署与健康检查完成：$HOST:$RELEASE_DIR"
