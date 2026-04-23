#requires -Version 5.1
<#
.SYNOPSIS
    发版脚本：一键 bump 版本号、构建 debug APK、更新 app-version.json。

.DESCRIPTION
    用法：
        .\release.ps1                          # 交互式询问更新说明，正常发版（版本 +1）
        .\release.ps1 -Notes "修 bug"          # 非交互，直接指定更新说明
        .\release.ps1 -SkipBuild               # 跳过构建（重新使用上次的 APK）
        .\release.ps1 -SkipBump                # 不 bump 版本号（重发当前版本）
        .\release.ps1 -SkipUpload              # 跳过上传到服务器

    脚本会：
      1. 读 sync_app_android/app/build.gradle.kts 里当前 versionCode / versionName
      2. bump 版本（除非 -SkipBump）：code +1，name 的 patch 段 +1（1.0.1 -> 1.0.2）
      3. 跑 sync_app_android/build_debug.bat 构建 debug APK
      4. 把 APK 复制成 <repo>/yhtiddly.apk
      5. 写 <repo>/app-version.json，供手机端 UpdateChecker 读取
      6. scp 两个文件到 todo:/var/www/yhtiddly-releases/
      7. curl 验证 https://yhtiddly.fun/app-version.json

    依赖：
      - OpenSSH (Windows 自带 ssh/scp)
      - ~/.ssh/config 里定义了 Host todo（User root, IdentityFile todo_deploy）
      - nginx 配置里已经加了 location = /yhtiddly.apk 和 /app-version.json 的静态映射

    签名注意：debug 构建用的是这台机器的 debug keystore，一直从这台机器发版即可。
#>
param(
    [string]$Notes = '',
    [switch]$SkipBuild,
    [switch]$SkipBump,
    [switch]$SkipUpload
)

$ErrorActionPreference = 'Stop'

# ---- Paths ----
$RepoRoot     = $PSScriptRoot
$AndroidDir   = Join-Path $RepoRoot 'sync_app_android'
$GradleFile   = Join-Path $AndroidDir 'app\build.gradle.kts'
$BuildBat     = Join-Path $AndroidDir 'build_debug.bat'
$ApkSrc       = Join-Path $AndroidDir 'app\build\outputs\apk\debug\app-debug.apk'
$ApkDst       = Join-Path $RepoRoot 'yhtiddly.apk'
$ManifestPath = Join-Path $RepoRoot 'app-version.json'

# ---- UTF-8 no BOM writer (works on both PS5 and PS7) ----
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
function Write-Utf8 {
    param([string]$Path, [string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, $script:Utf8NoBom)
}

# ---- 读取当前版本 ----
if (-not (Test-Path $GradleFile)) { throw "找不到 $GradleFile" }
$gradleText = Get-Content $GradleFile -Raw -Encoding UTF8
if ($gradleText -notmatch 'versionCode\s*=\s*(\d+)')        { throw '未在 gradle 中找到 versionCode' }
$curCode = [int]$Matches[1]
if ($gradleText -notmatch 'versionName\s*=\s*"([^"]+)"')    { throw '未在 gradle 中找到 versionName' }
$curName = $Matches[1]

# ---- 计算新版本 ----
if ($SkipBump) {
    $newCode = $curCode
    $newName = $curName
} else {
    $newCode = $curCode + 1
    $parts = $curName.Split('.')
    while ($parts.Count -lt 3) { $parts += '0' }
    $parts[-1] = [string]([int]$parts[-1] + 1)
    $newName = $parts -join '.'
}

Write-Host ''
Write-Host '=== yhtiddly 发版 ===' -ForegroundColor Cyan
Write-Host "  当前版本: v$curName (code $curCode)"
if (-not $SkipBump) {
    Write-Host "  发布版本: v$newName (code $newCode)" -ForegroundColor Green
} else {
    Write-Host "  重发当前版本（未 bump）" -ForegroundColor Yellow
}

# ---- 更新说明 ----
if ([string]::IsNullOrWhiteSpace($Notes)) {
    $Notes = Read-Host '更新说明'
}
if ([string]::IsNullOrWhiteSpace($Notes)) { $Notes = '-' }

# ---- 改 gradle ----
if (-not $SkipBump) {
    $updated = $gradleText `
        -replace 'versionCode\s*=\s*\d+', "versionCode = $newCode" `
        -replace 'versionName\s*=\s*"[^"]+"', "versionName = `"$newName`""
    Write-Utf8 -Path $GradleFile -Content $updated
    Write-Host '  ✓ gradle 已更新'
}

# ---- 构建 ----
if (-not $SkipBuild) {
    Write-Host '  → 正在构建 APK...' -ForegroundColor Cyan
    Push-Location $AndroidDir
    try {
        & cmd.exe /c $BuildBat
        if ($LASTEXITCODE -ne 0) { throw "构建失败 (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path $ApkSrc)) { throw "找不到构建产物 $ApkSrc，请先运行一次完整构建" }

# ---- 复制 APK ----
Copy-Item -Path $ApkSrc -Destination $ApkDst -Force
$sizeMb = [math]::Round((Get-Item $ApkDst).Length / 1MB, 2)
Write-Host "  ✓ APK 就位: yhtiddly.apk (${sizeMb} MB)"

# ---- 写 manifest ----
$manifest = [ordered]@{
    versionCode = $newCode
    versionName = $newName
    apkUrl      = '/yhtiddly.apk'
    notes       = $Notes
}
$json = ($manifest | ConvertTo-Json) + "`n"
Write-Utf8 -Path $ManifestPath -Content $json
Write-Host '  ✓ app-version.json 已更新'

# ---- 上传到服务器 ----
if (-not $SkipUpload) {
    Write-Host ''
    Write-Host '  → scp 上传到 todo:/var/www/yhtiddly-releases/' -ForegroundColor Cyan
    $remote = 'todo:/var/www/yhtiddly-releases/'
    & scp -o BatchMode=yes $ApkDst $ManifestPath $remote
    if ($LASTEXITCODE -ne 0) { throw "scp 上传失败 (exit $LASTEXITCODE)" }
    Write-Host '  ✓ 上传完成'

    # ---- 验证 ----
    Write-Host '  → 验证 https://yhtiddly.fun/app-version.json' -ForegroundColor Cyan
    try {
        $resp = Invoke-RestMethod -Uri 'https://yhtiddly.fun/app-version.json' -Headers @{'Cache-Control'='no-cache'} -TimeoutSec 15
        if ($resp.versionCode -eq $newCode -and $resp.versionName -eq $newName) {
            Write-Host "  ✓ 服务器返回版本 v$($resp.versionName) (code $($resp.versionCode))，匹配" -ForegroundColor Green
        } else {
            Write-Host "  ⚠ 服务器返回版本 v$($resp.versionName) (code $($resp.versionCode))，和本次发版不一致" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  ⚠ 验证请求失败: $_" -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host '=== 发版完成 ===' -ForegroundColor Green
Write-Host "  在手机上：菜单 -> 检查更新（当前 BuildConfig.VERSION_CODE 应该 < $newCode）"
Write-Host ''
