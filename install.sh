#!/usr/bin/env bash
# 把 dsh-ms-todo 装到本机的 DSH 主目录（macOS / Linux）。
#
#   bash install.sh                  # 装到 $DSH_HOME（没设就是 ~/.dsh）
#   DSH_HOME=/opt/dsh bash install.sh
#   SKIP_DATA=1 bash install.sh      # 只装代码和技能
#
# 幂等：重复跑只覆盖代码和技能。不会创建、复制或删除 auth.json —— 它不在包里。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bundle="$(dirname "$here")"

dsh_home="${DSH_HOME:-$HOME/.dsh}"

echo
echo "DSH 主目录: $dsh_home"
echo

# ── 1. 代码 ────────────────────────────────────────────────────────────────
dst_ms="$dsh_home/ms-todo"
mkdir -p "$dst_ms"
cp -f "$here"/ms-todo/*.mjs "$dst_ms"/
echo "  [1/4] 代码   $(ls -1 "$here"/ms-todo/*.mjs | wc -l | tr -d ' ') 个 .mjs -> $dst_ms"

# ── 2. 技能 ────────────────────────────────────────────────────────────────
dst_skill="$dsh_home/skills/microsoft-todo"
mkdir -p "$dst_skill"
cp -f "$here/skills/microsoft-todo/SKILL.md" "$dst_skill/"
echo "  [2/4] 技能   SKILL.md -> $dst_skill"

# ── 3. 数据 ────────────────────────────────────────────────────────────────
data_dir="$bundle/data"
if [ "${SKIP_DATA:-0}" = "1" ] || [ ! -d "$data_dir" ]; then
  echo "  [3/4] 数据   跳过"
else
  stamp="$(date +%Y%m%d-%H%M%S)"
  if [ -f "$dst_ms/state.json" ]; then
    cp -f "$dst_ms/state.json" "$dst_ms/state.json.bak-$stamp"
    echo "  [3/4] 数据   已存在的 state.json 备份到 state.json.bak-$stamp"
  fi
  cp -f "$data_dir/state.json" "$dst_ms/state.json"
  mkdir -p "$dst_ms/plans"
  if compgen -G "$data_dir/plans/*.json" > /dev/null; then
    cp -f "$data_dir"/plans/*.json "$dst_ms/plans/"
  fi
  echo "  [3/4] 数据   state.json + $(ls -1 "$data_dir"/plans/*.json 2>/dev/null | wc -l | tr -d ' ') 个计划 -> $dst_ms"
fi

# ── 4. 验证 ────────────────────────────────────────────────────────────────
echo
echo "验证："
if ! command -v node > /dev/null 2>&1; then
  echo "  ! 找不到 node —— 先装 Node.js >= 18"
  exit 1
fi
major="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$major" -lt 18 ]; then
  echo "  ! Node $(node -v) 太旧，需要 >= 18"
  exit 1
fi
echo "  Node $(node -v)  OK"
node "$dst_ms/check-skill.mjs" | tail -1

out="$(node "$dst_ms/todo.mjs" lists 2>&1 || true)"
if printf '%s' "$out" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  echo "  凭据  OK —— 已授权，可以直接用"
elif printf '%s' "$out" | grep -qE 'NOT_LOGGED_IN|REFRESH_FAILED'; then
  echo
  echo "  凭据  还没授权。跑这一条，然后在浏览器里输入它给的码："
  echo "        node \"$dst_ms/login.mjs\""
else
  echo "  凭据  检查失败，原始输出："
  echo "$out"
fi

echo
echo "装完了。自检（不需要凭据）："
echo "  node \"$dst_ms/test.mjs\""
echo "  node \"$dst_ms/e2e.mjs\""
echo "  node \"$dst_ms/schema-check.mjs\""
echo
