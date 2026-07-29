<#
.SYNOPSIS
    安装 UtilityLab 的 Git hooks。

.DESCRIPTION
    .git/hooks 不受版本控制，因此本仓库把 hook 脚本放在 scripts/git/hooks，
    再通过 core.hooksPath 让 Git 使用它。克隆仓库后运行一次即可。

.EXAMPLE
    pwsh -NoProfile -File ./scripts/git/install-hooks.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 默认按 OEM 代码页输出，中文在 UTF-8 终端会变成乱码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$repositoryRoot = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) {
    Write-Host '当前目录不在 Git 仓库中。' -ForegroundColor Red
    exit 2
}
$repositoryRoot = $repositoryRoot.Trim()

$hooksPath = 'scripts/git/hooks'
$fullHooksPath = Join-Path $repositoryRoot $hooksPath
if (-not (Test-Path -LiteralPath $fullHooksPath -PathType Container)) {
    Write-Host "找不到 hooks 目录：$fullHooksPath" -ForegroundColor Red
    exit 1
}

& git -C $repositoryRoot config core.hooksPath $hooksPath
if ($LASTEXITCODE -ne 0) {
    Write-Host 'core.hooksPath 设置失败。' -ForegroundColor Red
    exit 1
}

# 非 Windows 平台需要可执行位；Git for Windows 通过 sh 执行，不依赖该位。
# 不用 $IsLinux/$IsMacOS：这两个自动变量在 Windows PowerShell 5.1 中不存在，
# 在 Set-StrictMode 下引用会直接报错。
$isUnixLike = [System.IO.Path]::DirectorySeparatorChar -eq '/'
if ($isUnixLike) {
    foreach ($hook in Get-ChildItem -LiteralPath $fullHooksPath -File) {
        & chmod +x $hook.FullName
    }
}

Write-Host "已将 core.hooksPath 设置为 $hooksPath。" -ForegroundColor Green
Write-Host '现在每次 git commit 都会自动运行仓库策略检查。' -ForegroundColor Green
