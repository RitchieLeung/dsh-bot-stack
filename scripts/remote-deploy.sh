#!/usr/bin/env bash
# 在目标 Linux 主机执行：stop → backup → install → start → health / rollback。
set -eEuo pipefail

backup_paths() {
  local profileDir="$1" dataHome="$2" backupDir="$3"
  mkdir -p "$backupDir/profile" "$backupDir/installed"
  for file in package.json pnpm-lock.yaml cordis.patch.yml; do
    [ ! -f "$profileDir/$file" ] || cp -a "$profileDir/$file" "$backupDir/profile/$file"
  done
  for name in dscord dsh-plugin-bot-issue dsh-plugin-bot-knowledge dsh-plugin-bot-restart dsh-plugin-bot-ebook; do
    if [ -e "$profileDir/node_modules/$name" ] || [ -L "$profileDir/node_modules/$name" ]; then
      cp -a "$profileDir/node_modules/$name" "$backupDir/installed/$name"
    fi
  done
  [ -n "$dataHome" ] && [ "$dataHome" != "/" ] && [ "$dataHome" != "$HOME" ] || return 1
  # 新机器可能还没有数据目录；创建空目录后备份，恢复时也有明确目标。
  mkdir -p "$dataHome/bot" "$dataHome/dscord"
  tar -C "$dataHome" -czf "$backupDir/data.tgz" bot dscord
}

restore_paths() {
  local profileDir="$1" dataHome="$2" backupDir="$3"
  [ -f "$backupDir/data.tgz" ]
  for file in package.json pnpm-lock.yaml cordis.patch.yml; do
    [ ! -f "$backupDir/profile/$file" ] || cp -a "$backupDir/profile/$file" "$profileDir/$file"
  done
  for name in dscord dsh-plugin-bot-issue dsh-plugin-bot-knowledge dsh-plugin-bot-restart dsh-plugin-bot-ebook; do
    rm -rf "$profileDir/node_modules/$name"
    if [ -e "$backupDir/installed/$name" ] || [ -L "$backupDir/installed/$name" ]; then
      cp -a "$backupDir/installed/$name" "$profileDir/node_modules/$name"
    fi
  done
  [ -n "$dataHome" ] && [ "$dataHome" != "/" ] && [ "$dataHome" != "$HOME" ] || return 1
  # 先证明归档可读，再删除当前数据；损坏归档不能把旧数据也带走。
  tar -tzf "$backupDir/data.tgz" >/dev/null || return 1
  rm -rf "$dataHome/bot" "$dataHome/dscord"
  tar -C "$dataHome" -xzf "$backupDir/data.tgz"
}

basic_health() {
  local service="$1" graph
  sudo -n systemctl is-active --quiet "$service" || return 1
  graph="$(curl -s -m 4 http://127.0.0.1:3080/plugins/events || true)"
  for id in dscord dsh-plugin-bot-issue dsh-plugin-bot-knowledge dsh-plugin-bot-restart dsh-plugin-bot-ebook; do
    grep -q "\"id\":\"$id\"" <<<"$graph" || return 1
  done
}

main() {
  local releaseDir=""
  local service="${DSH_SERVICE:-dsh-web.service}"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --release-dir) releaseDir="$2"; shift 2 ;;
      --service) service="$2"; shift 2 ;;
      *) echo "未知参数：$1" >&2; return 2 ;;
    esac
  done
  [ -n "$releaseDir" ] || { echo "缺少 --release-dir" >&2; return 2; }

  local nodeHome="${DSH_NODE_HOME:-$HOME/.nvm/versions/node/v24.22.2}"
  local remoteRoot="${REMOTE_ROOT:-$(dirname "$(dirname "$releaseDir")")}"
  local profileDir="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
  local dataHome="${DSH_HOME:-$HOME/.dsh}"
  local node="$nodeHome/bin/node"
  local dsh="$nodeHome/bin/dsh"
  local pnpm="$nodeHome/bin/pnpm"
  local manifest="$releaseDir/dist/manifest.json"
  [ -f "$manifest" ] || { echo "缺少 $manifest" >&2; return 1; }

  local buildId
  buildId="$("$node" -e 'const m=require(process.argv[1]);process.stdout.write(m.stack.buildId)' "$manifest")"
  local backupDir="$remoteRoot/backups/$buildId"
  local packagesDir="$dataHome/bot/packages/$buildId"
  local oldPid startedAt backupDone=0 stopped=0
  oldPid="$(sudo -n systemctl show "$service" -p MainPID --value)"
  startedAt="$(date +%s%3N)"
  mkdir -p "$backupDir"
  printf '%s\n' "$oldPid" > "$backupDir/service.pid"

  rollback() {
    echo "开始回滚：恢复 profile、node_modules 和 bot/dscord 数据…" >&2
    sudo -n systemctl stop "$service" || true
    restore_paths "$profileDir" "$dataHome" "$backupDir"
    (cd "$profileDir" && "$pnpm" install --frozen-lockfile --ignore-scripts) || true
    sudo -n systemctl start "$service" || true
    sleep 3
    if basic_health "$service"; then echo "旧版本已恢复并通过基础健康检查。" >&2; else echo "回滚后基础健康检查仍未通过，备份在 $backupDir" >&2; fi
  }

  on_error() {
    local rc=$?
    trap - ERR
    set +e
    echo "部署失败（exit $rc），备份在 $backupDir" >&2
    if [ "$backupDone" = 1 ]; then
      rollback
    elif [ "$stopped" = 1 ]; then
      sudo -n systemctl start "$service" || true
    fi
    exit "$rc"
  }
  trap on_error ERR

  # 预检不写 profile：Node/DSH 版本、manifest 和 SHA 全在这里先过一遍。
  "$node" "$releaseDir/scripts/install.mjs" \
    --profile web --profile-dir "$profileDir" --dist "$releaseDir/dist" \
    --dsh-bin "$dsh" --packages-dir "$packagesDir" --backup-root "$backupDir/installer" --dry-run
  "$pnpm" config get registry >/dev/null
  sudo -n systemctl is-active --quiet "$service"

  # HMR 不能在安装中途读 profile；停服后备份也得到一致的 sqlite/WAL。
  sudo -n systemctl stop "$service"
  stopped=1
  for _ in $(seq 1 30); do
    if ! curl -s -m 1 http://127.0.0.1:3080/ >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if curl -s -m 1 http://127.0.0.1:3080/ >/dev/null 2>&1; then
    echo "服务停止后 3080 仍在响应，拒绝继续。" >&2
    return 1
  fi

  backup_paths "$profileDir" "$dataHome" "$backupDir"
  backupDone=1

  "$node" "$releaseDir/scripts/install.mjs" \
    --profile web --profile-dir "$profileDir" --dist "$releaseDir/dist" \
    --dsh-bin "$dsh" --packages-dir "$packagesDir" --backup-root "$backupDir/installer"

  sudo -n systemctl start "$service"
  stopped=0

  full_health() {
    basic_health "$service" || return 1
    local newPid
    newPid="$(sudo -n systemctl show "$service" -p MainPID --value)"
    [ -n "$newPid" ] && [ "$newPid" != "$oldPid" ] || return 1
    "$node" -e '
      const fs = require("fs");
      const start = Number(process.argv[1]);
      const file = process.argv[2];
      if (!fs.existsSync(file)) process.exit(2);
      const report = JSON.parse(fs.readFileSync(file, "utf8"));
      const expected = ["issue_create","issue_list","issue_get","issue_update","issue_assign","issue_link","issue_unlink","issue_comment"];
      if (report.at < start) throw new Error("tools.json 是旧的");
      if (report.failed?.length) throw new Error("工具注册失败：" + JSON.stringify(report.failed));
      for (const name of expected) if (!report.registered?.includes(name)) throw new Error("缺少工具：" + name);
    ' "$startedAt" "$dataHome/bot/issue/tools.json"
  }

  local healthy=0
  for _ in $(seq 1 60); do
    if full_health; then healthy=1; break; fi
    sleep 1
  done
  if [ "$healthy" != 1 ]; then
    sudo -n journalctl -u "$service" -n 80 --no-pager >&2 || true
    return 1
  fi

  # 健康已经确认：后续 current/cleanup/echo 失败不再把新代码和数据回滚掉。
  trap - ERR
  ln -sfn "$releaseDir" "$remoteRoot/releases/current"

  # 只清理确认健康后的旧 release，保留 5 个实体目录；current symlink 不占名额。
  ls -1dt "$remoteRoot/releases"/*/ 2>/dev/null | grep -v '/current/$' | tail -n +6 | while read -r old; do
    resolved="$(realpath "$old")"
    [ "$resolved" = "$releaseDir" ] && continue
    case "$resolved" in
      "$remoteRoot/releases"/*) rm -rf -- "$resolved" ;;
    esac
  done

  echo "146 部署健康：build $buildId，旧 pid $oldPid，新 pid $(sudo -n systemctl show "$service" -p MainPID --value)"
  echo "备份保留在 $backupDir"
}

# 测试可以 source 本文件，只调用 backup_paths / restore_paths，不启动主流程。
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi
main "$@"
