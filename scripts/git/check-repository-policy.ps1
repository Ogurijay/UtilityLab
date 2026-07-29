<#
.SYNOPSIS
    UtilityLab 仓库策略检查。

.DESCRIPTION
    校验 Git 索引（即将被提交的内容）是否符合 RULES.md：
      1. size           单文件不得超过 50 MB（硬性，不可豁免）
      2. asset          禁止提交数字创意资产
      3. secret-name    禁止提交敏感文件名 / 凭据文件
      4. secret-content 禁止在文本内容中出现明文凭据
      5. force-added    已被 .gitignore 排除却仍被追踪的文件需人工复核

    检查对象是索引中的 blob，而不是工作区文件——工作区副本可能已被修改或
    删除，只有索引内容才是真正会进入提交的内容。

    豁免机制见仓库根目录的 .policy-allow（size 规则永不可豁免）。

.NOTES
    本文件必须保存为「UTF-8 with BOM」。Windows PowerShell 5.1 会把无 BOM
    的 .ps1 按系统 ANSI 代码页解码，导致其中的中文字符串字面量损坏。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/git/check-repository-policy.ps1
#>
[CmdletBinding()]
param(
    # 仅输出违规项，不打印通过信息。
    [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 默认按 OEM 代码页输出，中文在 UTF-8 终端与 CI 日志中
# 会变成乱码。显式切到 UTF-8；个别宿主不支持时忽略即可。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$FailBytes = 50MB
$WarnBytes = 10MB
$AllowFileName = '.policy-allow'

# size 规则不在此列：它永不可豁免。
$ExemptableRules = @('asset', 'secret-name', 'secret-content', 'force-added')

# --- 数字创意资产扩展名 -------------------------------------------------------
# 与 .gitignore 的 "Digital creative assets" 段保持同步。
$BlockedExtensions = @(
    # 三维模型 / 场景
    '.fbx', '.obj', '.blend', '.blend1', '.gltf', '.glb', '.usd', '.usda',
    '.usdc', '.usdz', '.abc', '.dae', '.3ds', '.max', '.ma', '.mb', '.c4d',
    '.stl', '.ply', '.3mf', '.pmx', '.pmd', '.vrm', '.mdl', '.smd',
    # 引擎 / 打包资产
    '.uasset', '.umap', '.unitypackage', '.assetbundle', '.pak', '.upk',
    # 骨骼 / 动画 / 本仓库自有的运行时资产格式
    '.anim', '.bvh', '.skel', '.geom', '.name', '.tmd2', '.mbe', '.mat',
    '.bin',
    # 位图 / 贴图
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tga', '.tif',
    '.tiff', '.exr', '.hdr', '.dds', '.ktx', '.ktx2', '.basis', '.psd',
    '.psb', '.kra', '.clip', '.xcf',
    # 音频
    '.wav', '.mp3', '.ogg', '.flac', '.aac', '.m4a', '.aiff', '.opus',
    # 视频
    '.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm',
    # 字体（再分发通常受许可限制，见 RULES.md 第 4 节）
    '.ttf', '.otf', '.woff', '.woff2', '.ttc',
    # 归档：可绕过一切扩展名检查，因此一并拦截
    '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz',
    # 编译产物与可执行文件（RULES.md 第 2 节：构建产物默认不提交）
    '.exe', '.msi', '.dll', '.so', '.dylib', '.lib', '.a', '.pdb',
    '.wasm', '.node', '.class', '.jar'
)

# --- 敏感文件名 ---------------------------------------------------------------
$BlockedExactNames = @(
    'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
    '.netrc', '_netrc', '.pgpass', '.htpasswd',
    'credentials', 'kubeconfig', '.npmrc', '.pypirc'
)

# 与 .gitignore 的 "Sensitive configuration and credentials" 段保持同步。
$BlockedSecretExtensions = @(
    '.pem', '.key', '.pfx', '.p12', '.jks', '.keystore', '.ppk', '.asc',
    '.gpg', '.kdbx', '.ovpn'
)

$BlockedNamePatterns = @(
    # .env / .env.local / .env.production；.env*.example 等脱敏模板除外
    '^\.env(\..+)?$',
    # 名称任意位置含 credential(s) / secret(s) 的结构化配置
    '.*(credential|secret)s?.*\.(json|ya?ml|toml|ini|conf|config|xml)$',
    '^service-account.*\.json$'
)

$AllowedEnvTemplatePatterns = @(
    '^\.env\.(example|sample|template|dist)$',
    '^\.env\..+\.(example|sample|template|dist)$'
)

# --- 明文凭据内容特征 ---------------------------------------------------------
# 使用 POSIX ERE（git grep -E）：不支持 \d、(?i) 等 PCRE 语法。
$ContentPatterns = @(
    @{ Name = '私钥 PEM 块';          Pattern = '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----'; IgnoreCase = $false }
    @{ Name = 'PuTTY 私钥';           Pattern = 'PuTTY-User-Key-File-[0-9]';              IgnoreCase = $false }
    @{ Name = 'AWS Access Key ID';    Pattern = '(AKIA|ASIA)[0-9A-Z]{16}';                IgnoreCase = $false }
    @{ Name = 'GitHub Token';         Pattern = 'gh[pousr]_[A-Za-z0-9]{36,}';             IgnoreCase = $false }
    @{ Name = 'Anthropic/OpenAI Key'; Pattern = 'sk-(ant-)?[A-Za-z0-9_-]{24,}';           IgnoreCase = $false }
    @{ Name = 'Slack Token';          Pattern = 'xox[baprs]-[A-Za-z0-9-]{10,}';           IgnoreCase = $false }
    @{ Name = 'Google API Key';       Pattern = 'AIza[0-9A-Za-z_-]{35}';                  IgnoreCase = $false }
    @{ Name = 'JWT';                  Pattern = 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'; IgnoreCase = $false }
    @{ Name = '疑似硬编码凭据赋值';   Pattern = '[A-Za-z0-9_.-]*(api_?key|secret|password|passwd|token|credential)[A-Za-z0-9_.-]*[[:space:]]*[:=][[:space:]]*[^[:space:]]{16,}'; IgnoreCase = $true }
)

# ---------------------------------------------------------------------------

# 说明：刻意不使用 `2>&1`。在 Windows PowerShell 5.1 中，把原生命令的 stderr
# 合并进成功流会在 $ErrorActionPreference='Stop' 下抛出 NativeCommandError，
# 而 git grep 等命令用非零退出码表示"无匹配"属于正常语义。
function Invoke-Git {
    param(
        [Parameter(Mandatory)][string[]]$Arguments
    )
    $output = & git @Arguments
    return @($output)
}

$repositoryRoot = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repositoryRoot) {
    Write-Host '当前目录不在 Git 仓库中。' -ForegroundColor Red
    exit 2
}
$repositoryRoot = ([string]$repositoryRoot).Trim()

function Convert-GlobToRegex {
    param([Parameter(Mandatory)][string]$Glob)
    # 目录形式 dir/ 视为 dir/ 下的全部内容
    if ($Glob.EndsWith('/')) { $Glob = $Glob + '**' }
    $escaped = [Regex]::Escape($Glob)
    # Regex.Escape 把 * 转成 \*、? 转成 \?；此处还原为通配语义：
    # ** 跨目录，* 与 ? 不跨目录。
    # 用 ASCII 哨兵占位（glob 中不会出现），兼容 Windows PowerShell 5.1
    $sentinel = '<<DOUBLESTAR>>'
    $escaped = $escaped -replace '\\\*\\\*', $sentinel
    $escaped = $escaped -replace '\\\*', '[^/]*'
    $escaped = $escaped -replace '\\\?', '[^/]'
    $escaped = $escaped.Replace($sentinel, '.*')
    return "^$escaped$"
}

function Read-AllowList {
    param([Parameter(Mandatory)][string]$Root)

    $entries = [System.Collections.Generic.List[object]]::new()
    $path = Join-Path $Root $AllowFileName
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return $entries
    }

    $lineNumber = 0
    foreach ($rawLine in @(Get-Content -LiteralPath $path -Encoding UTF8)) {
        $lineNumber++
        $line = ([string]$rawLine).Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }

        # 形式：<glob>            或            <glob> = rule1,rule2
        $glob = $line
        $rules = $ExemptableRules
        $separator = $line.IndexOf('=')
        if ($separator -ge 0) {
            $glob = $line.Substring(0, $separator).Trim()
            $ruleText = $line.Substring($separator + 1).Trim()
            # 允许行尾注释：MyTool/x = asset  # 理由
            $commentAt = $ruleText.IndexOf('#')
            if ($commentAt -ge 0) { $ruleText = $ruleText.Substring(0, $commentAt).Trim() }
            $rules = @($ruleText -split ',' |
                ForEach-Object { $_.Trim().ToLowerInvariant() } |
                Where-Object { $_ })
        }
        if (-not $glob) { continue }

        $unknown = @($rules | Where-Object { $ExemptableRules -notcontains $_ })
        if ($unknown.Count -gt 0) {
            Write-Host "$AllowFileName 第 $lineNumber 行含不可豁免或未知的规则：$($unknown -join ', ')" -ForegroundColor Red
            Write-Host "可豁免的规则：$($ExemptableRules -join ', ')（size 不可豁免）" -ForegroundColor Red
            exit 2
        }

        $entries.Add([pscustomobject]@{
            Glob  = $glob
            Regex = Convert-GlobToRegex -Glob $glob
            Rules = $rules
        })
    }
    return $entries
}

$AllowList = @(Read-AllowList -Root $repositoryRoot)

$violations = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$exempted = [System.Collections.Generic.List[string]]::new()

function Test-Allowed {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Rule
    )
    foreach ($entry in $AllowList) {
        if ($entry.Rules -contains $Rule -and $Path -match $entry.Regex) {
            return $true
        }
    }
    return $false
}

function Add-Finding {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Rule,
        [Parameter(Mandatory)][string]$Message
    )
    if ($ExemptableRules -contains $Rule -and (Test-Allowed -Path $Path -Rule $Rule)) {
        $exempted.Add("$Path [$Rule] $Message")
        return
    }
    $violations.Add("$Path [$Rule] $Message")
}

# --- 读取索引条目（mode sha stage<TAB>path） ---------------------------------
$indexEntries = [System.Collections.Generic.List[object]]::new()
foreach ($line in (Invoke-Git -Arguments @('-C', $repositoryRoot, 'ls-files', '--stage'))) {
    if (-not $line) { continue }
    $match = [Regex]::Match([string]$line, '^(?<mode>\d{6})\s+(?<sha>[0-9a-f]{40,})\s+(?<stage>\d)\t(?<path>.+)$')
    if (-not $match.Success) { continue }
    # 跳过 gitlink（子模块）：其 sha 指向另一个仓库的提交，不是本仓库的 blob
    if ($match.Groups['mode'].Value -eq '160000') { continue }
    $indexEntries.Add([pscustomobject]@{
        Sha  = $match.Groups['sha'].Value
        Path = $match.Groups['path'].Value
    })
}

if ($indexEntries.Count -eq 0) {
    Write-Host '索引为空，无需检查。' -ForegroundColor Yellow
    exit 0
}

# 批量取 blob 真实大小。--batch-check 默认输出 "<sha> <type> <size>"，
# 不传自定义格式可避免跨平台的参数引号问题。
$sizeBySha = @{}
$uniqueShas = @($indexEntries | Select-Object -ExpandProperty Sha -Unique)
$batchOutput = ($uniqueShas -join "`n") | & git -C $repositoryRoot cat-file --batch-check
foreach ($line in @($batchOutput)) {
    $parts = ([string]$line) -split '\s+'
    if ($parts.Count -ge 3 -and $parts[1] -eq 'blob' -and $parts[2] -match '^\d+$') {
        $sizeBySha[$parts[0]] = [long]$parts[2]
    }
}

foreach ($entry in $indexEntries) {
    $path = $entry.Path
    $name = [System.IO.Path]::GetFileName($path)
    $lowerName = $name.ToLowerInvariant()
    $extension = [System.IO.Path]::GetExtension($name).ToLowerInvariant()

    # 1. size —— 硬性规则，不查豁免表
    if ($sizeBySha.ContainsKey($entry.Sha)) {
        $size = $sizeBySha[$entry.Sha]
        if ($size -gt $FailBytes) {
            $mb = [Math]::Round($size / 1MB, 2)
            $violations.Add("$path [size] 超过 50 MB（$mb MB），该上限不可豁免")
        }
        elseif ($size -gt $WarnBytes) {
            $mb = [Math]::Round($size / 1MB, 2)
            $warnings.Add("$path 体积较大（$mb MB），请确认确有必要")
        }
    }

    # 2. asset
    if ($BlockedExtensions -contains $extension) {
        Add-Finding -Path $path -Rule 'asset' -Message "禁止提交的数字创意资产或归档（$extension）"
    }

    # 3. secret-name
    $isEnvTemplate = $false
    foreach ($pattern in $AllowedEnvTemplatePatterns) {
        if ($lowerName -match $pattern) { $isEnvTemplate = $true; break }
    }

    if (-not $isEnvTemplate) {
        $nameHit = $false
        if ($BlockedExactNames -contains $lowerName) { $nameHit = $true }
        if (-not $nameHit -and $BlockedSecretExtensions -contains $extension) { $nameHit = $true }
        if (-not $nameHit) {
            foreach ($pattern in $BlockedNamePatterns) {
                if ($lowerName -match $pattern) { $nameHit = $true; break }
            }
        }
        if ($nameHit) {
            Add-Finding -Path $path -Rule 'secret-name' -Message '文件名表明其可能包含凭据或私钥'
        }
    }
}

# 4. secret-content —— 用 git grep 搜索索引，-I 自动跳过二进制文件
foreach ($spec in $ContentPatterns) {
    $arguments = @('-C', $repositoryRoot, 'grep', '--cached', '-I', '-n', '-E')
    if ($spec.IgnoreCase) { $arguments += '-i' }
    $arguments += @('-e', $spec.Pattern)

    $found = Invoke-Git -Arguments $arguments
    # git grep：0 = 有匹配，1 = 无匹配（正常），>1 = 真错误
    if ($LASTEXITCODE -gt 1) {
        Write-Host "git grep 执行失败（退出码 $LASTEXITCODE），模式：$($spec.Name)" -ForegroundColor Red
        exit 2
    }
    foreach ($line in $found) {
        if (-not $line) { continue }
        $parts = ([string]$line) -split ':', 3
        if ($parts.Count -lt 2) { continue }
        Add-Finding -Path $parts[0] -Rule 'secret-content' `
            -Message "第 $($parts[1]) 行出现$($spec.Name)特征"
    }
}

# 5. force-added —— 已被 .gitignore 排除却仍被追踪
$forceAdded = Invoke-Git -Arguments @(
    '-C', $repositoryRoot, 'ls-files', '--cached', '-i', '--exclude-standard'
)
foreach ($line in $forceAdded) {
    if (-not $line) { continue }
    Add-Finding -Path ([string]$line) -Rule 'force-added' `
        -Message '被 .gitignore 排除却仍被追踪（疑似 git add -f），需人工复核'
}

# --- 输出 -------------------------------------------------------------------
if ($exempted.Count -gt 0 -and -not $Quiet) {
    Write-Host "已按 $AllowFileName 豁免 $($exempted.Count) 项：" -ForegroundColor DarkGray
    foreach ($item in $exempted) { Write-Host " - $item" -ForegroundColor DarkGray }
}

if ($warnings.Count -gt 0) {
    Write-Host '策略检查警告：' -ForegroundColor Yellow
    foreach ($item in $warnings) { Write-Host " - $item" -ForegroundColor Yellow }
}

if ($violations.Count -gt 0) {
    Write-Host ''
    Write-Host "策略检查未通过，共 $($violations.Count) 项违规：" -ForegroundColor Red
    foreach ($item in $violations) { Write-Host " - $item" -ForegroundColor Red }
    Write-Host ''
    Write-Host "如确属必要，请在 $AllowFileName 中登记豁免，并写明来源、许可证与必要性" -ForegroundColor Red
    Write-Host '（50 MB 上限不可豁免）。详见 RULES.md。' -ForegroundColor Red
    exit 1
}

if (-not $Quiet) {
    Write-Host "策略检查通过：已校验索引中 $($indexEntries.Count) 个文件。" -ForegroundColor Green
}
exit 0
