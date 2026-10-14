# 把 dsh-ms-todo 装到本机的 DSH 主目录。
#
#   .\install.ps1                     # 装到 $env:DSH_HOME（没设就是 ~\.dsh）
#   .\install.ps1 -DshHome D:\dsh     # 装到指定目录
#   .\install.ps1 -SkipData           # 只装代码和技能，不动 state.json / plans
#
# 幂等：重复跑只覆盖代码和技能。不会创建、复制或删除 auth.json —— 它不在包里，
# 换机后要自己跑一次 login.mjs 授权。
[CmdletBinding()]
param(
    [string]$DshHome,
    [switch]$SkipData
)

$ErrorActionPreference = 'Stop'

if (-not $DshHome) { $DshHome = $env:DSH_HOME }
if (-not $DshHome) { $DshHome = Join-Path $HOME '.dsh' }
$DshHome = [System.IO.Path]::GetFullPath($DshHome)

$repo   = $PSScriptRoot
$bundle = Split-Path $repo -Parent

Write-Host ""
Write-Host "DSH 主目录: $DshHome"
Write-Host ""

# ── 1. 代码 ────────────────────────────────────────────────────────────────
$dstMs = Join-Path $DshHome 'ms-todo'
New-Item -ItemType Directory -Force -Path $dstMs | Out-Null
Copy-Item (Join-Path $repo 'ms-todo\*.mjs') -Destination $dstMs -Force
Write-Host ("  [1/4] 代码   {0} 个 .mjs -> {1}" -f (Get-ChildItem (Join-Path $repo 'ms-todo\*.mjs')).Count, $dstMs)

# ── 2. 技能 ────────────────────────────────────────────────────────────────
$dstSkill = Join-Path $DshHome 'skills\microsoft-todo'
New-Item -ItemType Directory -Force -Path $dstSkill | Out-Null
Copy-Item (Join-Path $repo 'skills\microsoft-todo\SKILL.md') -Destination $dstSkill -Force
Write-Host "  [2/4] 技能   SKILL.md -> $dstSkill"

# ── 3. 数据（state.json + plans/）──────────────────────────────────────────
# 只在包旁边真的有 data\ 目录时才搬。已存在的 state.json 会先备份，
# 因为它是"哪些待办是 DSH 建的"的唯一记录，覆盖错了 apply 可能删错东西。
$dataDir = Join-Path $bundle 'data'
if ($SkipData -or -not (Test-Path $dataDir)) {
    $why = if ($SkipData) { '-SkipData' } else { '包里没有 data\ 目录' }
    Write-Host "  [3/4] 数据   跳过（$why）"
} else {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dstState = Join-Path $dstMs 'state.json'
    if (Test-Path $dstState) {
        $bak = "$dstState.bak-$stamp"
        Copy-Item $dstState $bak -Force
        Write-Host "  [3/4] 数据   已存在的 state.json 备份到 $bak"
    }
    Copy-Item (Join-Path $dataDir 'state.json') -Destination $dstState -Force

    $dstPlans = Join-Path $dstMs 'plans'
    New-Item -ItemType Directory -Force -Path $dstPlans | Out-Null
    $plans = Get-ChildItem (Join-Path $dataDir 'plans\*.json') -ErrorAction SilentlyContinue
    if ($plans) { $plans | Copy-Item -Destination $dstPlans -Force }
    Write-Host ("  [3/4] 数据   state.json + {0} 个计划 -> {1}" -f @($plans).Count, $dstMs)
}

# ── 4. 环境变量 + 验证 ─────────────────────────────────────────────────────
# 把 DSH_HOME 钉成用户级变量，这样任何新开的 shell 里 $env:DSH_HOME 都在，
# SKILL.md 里所有命令才能直接用。空值不写。
if ($DshHome) {
    [Environment]::SetEnvironmentVariable('DSH_HOME', $DshHome, 'User')
    $env:DSH_HOME = $DshHome
    Write-Host "  [4/4] 环境   DSH_HOME=$DshHome（用户级，新开的终端也生效）"
}

Write-Host ""
Write-Host "验证："
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  ! 找不到 node —— 先装 Node.js >= 18"
    exit 1
}
$ver = (& node -v) -replace '^v', ''
if ([int]($ver -split '\.')[0] -lt 18) {
    Write-Host "  ! Node $ver 太旧，需要 >= 18"
    exit 1
}
Write-Host "  Node $ver  OK"

& node (Join-Path $dstMs 'check-skill.mjs') | Select-Object -Last 1

& node (Join-Path $dstMs 'todo.mjs') lists 2>&1 | Out-String | ForEach-Object {
    if ($_ -match '"ok"\s*:\s*true') {
        Write-Host "  凭据  OK —— 已授权，可以直接用"
    } elseif ($_ -match 'NOT_LOGGED_IN|REFRESH_FAILED') {
        Write-Host ""
        Write-Host "  凭据  还没授权。跑这一条，然后在浏览器里输入它给的码："
        Write-Host "        node `"$dstMs\login.mjs`""
    } else {
        Write-Host "  凭据  检查失败，原始输出："
        Write-Host $_
    }
}

Write-Host ""
Write-Host "装完了。自检（不需要凭据）："
Write-Host "  node `"$dstMs\test.mjs`""
Write-Host "  node `"$dstMs\e2e.mjs`""
Write-Host "  node `"$dstMs\schema-check.mjs`""
Write-Host ""
