[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$maximumBytes = 50MB
$blockedExtensions = @(
    '.fbx', '.obj', '.blend', '.blend1', '.gltf', '.glb', '.usd', '.usda',
    '.usdc', '.abc', '.bvh', '.dae', '.3ds', '.max', '.ma', '.mb',
    '.uasset', '.umap', '.anim', '.png', '.jpg', '.jpeg', '.webp', '.tga',
    '.tif', '.tiff', '.exr', '.hdr', '.psd', '.kra', '.wav', '.mp3',
    '.ogg', '.flac', '.mp4', '.mov', '.avi', '.mkv'
)
$blockedNames = @(
    '.env', 'id_rsa', 'id_ed25519'
)

$repositoryRoot = (git rev-parse --show-toplevel 2>$null)
if (-not $repositoryRoot) {
    throw 'The current directory is not inside a Git repository.'
}

$violations = [System.Collections.Generic.List[string]]::new()
$trackedPaths = @(git -C $repositoryRoot ls-files)

foreach ($relativePath in $trackedPaths) {
    $fullPath = Join-Path $repositoryRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        continue
    }

    $file = Get-Item -LiteralPath $fullPath
    $extension = $file.Extension.ToLowerInvariant()
    $lowerName = $file.Name.ToLowerInvariant()

    if ($file.Length -gt $maximumBytes) {
        $sizeMb = [Math]::Round($file.Length / 1MB, 2)
        $violations.Add("$relativePath exceeds 50 MB ($sizeMb MB)")
    }

    if ($blockedExtensions -contains $extension) {
        $violations.Add("$relativePath is a blocked digital creative asset")
    }

    if (($blockedNames -contains $lowerName) -or
        ($lowerName -match '^(credentials|secrets).*\.(json|ya?ml|toml)$')) {
        $violations.Add("$relativePath may contain sensitive configuration")
    }
}

if ($violations.Count -gt 0) {
    Write-Host 'Repository policy check failed:' -ForegroundColor Red
    $violations | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
    exit 1
}

Write-Host "Repository policy check passed for $($trackedPaths.Count) tracked files." -ForegroundColor Green
