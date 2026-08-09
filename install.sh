#!/usr/bin/env bash
# ============================================================
# minicode 交互式安装脚本
#
# 功能:
#   1. 检查 Node 环境(>= 20.12)
#   2. 安装依赖(pnpm 优先, 可回退 npm)
#   3. 构建单文件可执行包 dist/minicode.mjs
#   4. 注册全局命令(默认 ~/.local/bin; 或 /usr/local/bin 需要 sudo)
#   5. 自动把安装目录写入 PATH(zshrc/bashrc)
#
# 用法:
#   bash install.sh             # 交互安装
#   bash install.sh -y          # 全自动(默认 ~/.local/bin)
#   bash install.sh --prefix /usr/local/bin
#   bash install.sh uninstall   # 卸载
# ============================================================
set -euo pipefail

YELLOW='\033[33m'; GREEN='\033[32m'; RED='\033[31m'; CYAN='\033[36m'; BOLD='\033[1m'; RESET='\033[0m'
info() { printf "${CYAN}%s${RESET}\n" "$*"; }
ok()   { printf "${GREEN}✓ %s${RESET}\n" "$*"; }
warn() { printf "${YELLOW}%s${RESET}\n" "$*"; }
err()  { printf "${RED}✗ %s${RESET}\n" "$*" >&2; exit 1; }

ASSUME_YES=0
PREFIX=""
MODE="install"

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --prefix=*) PREFIX="${arg#--prefix=}" ;;
    uninstall) MODE="uninstall" ;;
    *) warn "未知参数: $arg(忽略)" ;;
  esac
done

ask_yesno() {
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  printf "%s [y/N] " "$1"
  local ans
  read -r ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ]
}

# ---------- 卸载 ----------
if [ "$MODE" = "uninstall" ]; then
  for cand in "${PREFIX:+$PREFIX/minicode}" "$HOME/.local/bin/minicode" "/usr/local/bin/minicode"; do
    [ -z "$cand" ] && continue
    if [ -e "$cand" ] || [ -L "$cand" ]; then
      rm -f "$cand"
      ok "已删除 $cand"
    fi
  done
  echo
  info "已卸载。项目内缓存目录 .minicode/ 保留(内容是你的对话记录), 如需清除请手动删除。"
  exit 0
fi

echo "${BOLD}minicode 安装脚本${RESET}"
echo "----------------"

# ---------- 1. 环境检查 ----------
command -v node >/dev/null 2>&1 || err "未找到 Node.js。请先安装 Node >= 20.12(nodejs.org)"
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 20 ] || err "Node 版本过低: v$NODE_MAJOR(需要 >= 20.12)"
ok "Node $(node -v) $(command -v node)"

# ---------- 2. 依赖安装 ----------
PM=""
if [ -z "$PM" ] && command -v pnpm >/dev/null 2>&1; then PM="pnpm"; fi
if [ -z "$PM" ] && command -v npm >/dev/null 2>&1; then PM="npm"; fi

if [ -d node_modules ]; then
  ok "依赖已安装(node_modules 存在), 跳过"
else
  info "安装依赖($PM)…"
  if [ "$PM" = "pnpm" ]; then
    pnpm install || err "pnpm install 失败"
  else
    npm install || err "npm install 失败"
  fi
fi

# ---------- 3. 构建 ----------
info "构建 dist/minicode.mjs…"
"$PM" run build || err "构建失败(请检查 Node 版本)"
[ -f dist/minicode.mjs ] || err "构建产物缺失: dist/minicode.mjs"
ok "构建完成 ($(du -h dist/minicode.mjs | cut -f1))"

# ---------- 4. 安装位置 ----------
DEFAULT_PREFIX="$HOME/.local/bin"
if [ -z "$PREFIX" ]; then
  echo
  read -r -p "安装到 [$DEFAULT_PREFIX]? (输入路径, 或直接回车): " PREFIX
  PREFIX="${PREFIX:-$DEFAULT_PREFIX}"
fi
PREFIX="${PREFIX/#~/$HOME}"

if mkdir -p "$PREFIX" 2>/dev/null; then
  :
else
  warn "目录 $PREFIX 需要权限, 尝试 sudo…"
  sudo mkdir -p "$PREFIX"
fi
[ -w "$PREFIX" ] || { warn "$PREFIX 不可写: 尝试 sudo 复制"; sudo cp dist/minicode.mjs "$PREFIX/minicode" && sudo chmod +x "$PREFIX/minicode" && ok "已安装 $PREFIX/minicode"; }
if [ -w "$PREFIX" ]; then
  cp dist/minicode.mjs "$PREFIX/minicode"
  chmod +x "$PREFIX/minicode"
  ok "已安装 $PREFIX/minicode"
fi

# ---------- 5. PATH ----------
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *)
    if ask_yesno "$PREFIX 不在 PATH 中, 要自动加入 shell 配置吗?"; then
      RC=""
      case "${SHELL##*/}" in
        zsh) RC="$HOME/.zshrc" ;;
        bash) RC="$HOME/.bashrc" ;;
      esac
      if [ -n "$RC" ]; then
        printf '\nexport PATH="%s:$PATH"\n' "$PREFIX" >> "$RC"
        ok "已写入 $RC(重新打开终端或 source $RC 生效)"
      else
        warn "无法识别 shell(${SHELL}), 请手动把 $PREFIX 加入 PATH"
      fi
    fi
    ;;
esac

echo
echo "----------------"
ok "minicode 安装完成!"
echo
printf "${BOLD}用法${RESET}:\n"
echo "  minicode                      # 对话 TUI(自动在项目目录创建 .minicode/ 缓存)"
echo "  minicode --headless '<问题>'  # 一次性对话"
echo "  minicode -r                   # 恢复最近会话"
echo "  minicode --help               # 更多选项"
echo "  bash install.sh uninstall     # 卸载"
echo
info "提示: 在每个项目目录使用时会自动生成 .minicode/(会话/配置/日志), 建议加入 .gitignore"