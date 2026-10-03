<#
.SYNOPSIS
    Publish this plugin to a GitHub repository using the REST API only. No git needed.

.DESCRIPTION
    Reads a token from the GH_TOKEN environment variable (or -Token), then:
      1. verifies the token;
      2. creates the public repository when it does not exist yet;
      3. writes url/author into plugin.json and the LICENSE copyright line;
      4. uploads every tracked file through the Git Data API (blobs -> tree -> commit -> ref);
      5. creates a v<version> tag;
      6. prints the info needed for the SiYuan marketplace listing request.

    The token is never written to disk and never printed.

.PARAMETER RepoName
    Repository name. Defaults to the "name" field of plugin.json.

.PARAMETER Owner
    GitHub user or organisation owning the repository. Defaults to the authenticated user.

.PARAMETER Author
    Author written into plugin.json and LICENSE. Defaults to the value already in plugin.json.

.PARAMETER Token
    GitHub token. Prefer the GH_TOKEN environment variable.

.PARAMETER Private
    Create the repository as private (for a trial run). The marketplace needs it public.

.EXAMPLE
    $env:GH_TOKEN = "github_pat_xxx"
    .\scripts\publish-via-api.ps1
#>
[CmdletBinding()]
param(
    [string]$RepoName = "",
    [string]$Owner = "",
    [string]$Author = "",
    [string]$Token = "",
    [switch]$Private
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function SayStep($m) { Write-Host "[publish] $m" -ForegroundColor Cyan }
function SayWarn($m) { Write-Host "[publish] $m" -ForegroundColor Yellow }
function SayFail($m) { Write-Host "[publish] FAILED: $m" -ForegroundColor Red; exit 1 }

if ($Token -eq "") { $Token = $env:GH_TOKEN }
if ($Token -eq "") {
    SayWarn "No token found. Create a fine-grained Personal Access Token and set it first:"
    SayWarn '  $env:GH_TOKEN = "github_pat_xxx"'
    SayWarn "Permissions needed: Administration (read/write) + Contents (read/write)."
    SayFail "missing token"
}

$api = "https://api.github.com"

# PowerShell 5.1 的 SecurityProtocol 默认可能不含 TLS 1.2，而 GitHub 要求 TLS 1.2+；
# 不显式设置会出现偶发的「操作超时」。
try {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
} catch {
    SayWarn ("could not force TLS 1.2: " + $_.Exception.Message)
}
# .NET 默认每主机连接数较少，高频请求下容易排队超时
try { [System.Net.ServicePointManager]::DefaultConnectionLimit = 8 } catch { }

$baseHeaders = @{
    Authorization          = "Bearer " + $Token
    "User-Agent"           = "siyuan-plugin-publish"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
}

# 统一的 API 调用：**不主动退出**，把状态码与 GitHub 的原始响应交回调用方判断。
#
# 为什么不用 Invoke-WebRequest：
#   1) `-SkipHttpErrorCheck` 是 PowerShell 7+ 专有参数，本机只有 5.1；
#   2) 即使改用 try/catch，「409 冲突 + 空响应体」也会出现在**正常应返回 201** 的
#      blob 创建请求上 —— 这是 PS 5.1 的 Invoke-WebRequest 在连接复用/请求体处理上的
#      已知怪癖，与服务端无关（GitHub 侧其实创建成功了）。
# 因此这里直接用 .NET 的 HttpWebRequest，完全掌控请求与响应。
function Invoke-GitHubApi {
    param(
        [string]$Method,
        [string]$Uri,
        $Body
    )

    $request = [System.Net.HttpWebRequest]::Create($Uri)
    $request.Method = $Method
    $request.UserAgent = "siyuan-plugin-publish"
    $request.Accept = "application/vnd.github+json"
    $request.Headers.Add("Authorization", "Bearer " + $Token)
    $request.Headers.Add("X-GitHub-Api-Version", "2022-11-28")
    $request.Timeout = 60000
    $request.ReadWriteTimeout = 120000
    # 关闭 100-continue：PS/.NET 组合下可能触发莫名的 409
    $request.ServicePoint.Expect100Continue = $false

    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 10 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $request.ContentType = "application/json; charset=utf-8"
        $request.ContentLength = $bytes.Length
        try {
            $stream = $request.GetRequestStream()
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Close()
        } catch {
            return @{ ok = $false; status = 0; data = $null; raw = ""; error = ("request stream: " + $_.Exception.Message) }
        }
    }

    $status = 0
    $raw = ""
    try {
        $response = $request.GetResponse()
        $status = [int]$response.StatusCode
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        $raw = $reader.ReadToEnd()
        $reader.Close()
        $response.Close()
    } catch [System.Net.WebException] {
        $webResp = $_.Exception.Response
        if ($null -ne $webResp) {
            try { $status = [int]$webResp.StatusCode } catch { $status = 0 }
            try {
                $reader = New-Object System.IO.StreamReader($webResp.GetResponseStream())
                $raw = $reader.ReadToEnd()
                $reader.Close()
            } catch { $raw = "" }
            try { $webResp.Close() } catch { }
        }
        if ($raw -eq "") { $raw = $_.Exception.Message }
    } catch {
        return @{ ok = $false; status = 0; data = $null; raw = ""; error = $_.Exception.Message }
    }

    if ($status -ge 200 -and $status -lt 300) {
        $data = $null
        if ($raw -ne "") {
            try { $data = $raw | ConvertFrom-Json } catch { $data = $null }
        }
        return @{ ok = $true; status = $status; data = $data; raw = $raw; error = "" }
    }
    return @{ ok = $false; status = $status; data = $null; raw = $raw; error = $raw }
}

# ---------------------------------------------------------------- 0. manifest
$pluginJsonPath = Join-Path $root "plugin.json"
if (-not (Test-Path $pluginJsonPath)) { SayFail "plugin.json not found" }
$manifest = Get-Content $pluginJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($RepoName -eq "") { $RepoName = $manifest.name }
SayStep ("plugin " + $manifest.name + " v" + $manifest.version + "  ->  repo " + $RepoName)

# ---------------------------------------------------------------- 1. token check
$me = Invoke-GitHubApi -Method "GET" -Uri "$api/user" -Body $null
if (-not $me.ok) {
    if ($me.status -eq 401) {
        SayFail "token rejected (401). The token is wrong, expired, or lacks permissions."
    }
    SayFail ("could not verify token: HTTP " + $me.status + " " + $me.error)
}
$login = $me.data.login
SayStep ("authenticated as " + $login)

if ($Owner -eq "") { $Owner = $login }

# 提前告知 token 权限不足的常见表现（fine-grained token 需要 Administration 权限才能建仓库）
$canCreate = $true

# ---------------------------------------------------------------- 2. repository
# 注意：404 表示「仓库还不存在」，这正是首次发布时的正常情况。
$repoInfo = Invoke-GitHubApi -Method "GET" -Uri "$api/repos/$Owner/$RepoName" -Body $null
$repoExists = $repoInfo.ok

if ($repoExists) {
    SayStep "repository already exists, reusing it"
    $htmlUrl = $repoInfo.data.html_url
} else {
    if ($repoInfo.status -ne 404) {
        SayFail ("cannot check repository: HTTP " + $repoInfo.status + " " + $repoInfo.error)
    }
    SayStep "repository does not exist yet, creating it ..."
    $payload = @{
        name        = $RepoName
        private     = [bool]$Private
        description = "Calendar view for SiYuan with two-way CalDAV sync"
        has_issues  = $true
        auto_init   = $false
    }
    $created = Invoke-GitHubApiWithRetry -Method "POST" -Uri "$api/user/repos" -Body $payload -Label "create-repo"
    if (-not $created.ok) {
        if ($created.status -eq 403 -or $created.status -eq 404) {
            SayWarn "creating the repository was refused (HTTP $($created.status))."
            SayWarn "A fine-grained token needs 'Administration: Read and write' to create repositories."
            SayWarn "Either grant that permission, or create the empty public repository by hand at:"
            SayWarn "  https://github.com/new"
            SayWarn "then run this script again (it will reuse the existing repository)."
        }
        SayFail ("create repository: HTTP " + $created.status + " " + $created.error)
    }
    $htmlUrl = $created.data.html_url
    SayStep ("repository created: " + $htmlUrl)
}

if ($Private) {
    SayWarn "repository is PRIVATE - the SiYuan marketplace cannot distribute a private repo"
}

# ---------------------------------------------------------------- 3. manifest fields
# 署名优先级：-Author 参数 > plugin.json 里已有的真实署名 > 占位值。
$PLACEHOLDER_AUTHOR = "SiYuan Calendar CalDAV Contributors"
if ($Author -eq "" -or $Author -eq $PLACEHOLDER_AUTHOR) {
    $existing = $manifest.author
    if ($existing -ne "" -and $existing -ne $PLACEHOLDER_AUTHOR) {
        $Author = $existing
    } elseif ($Author -eq "") {
        $Author = $PLACEHOLDER_AUTHOR
    }
}

$text = [System.IO.File]::ReadAllText($pluginJsonPath, [System.Text.UTF8Encoding]::new($false))
$text = $text -replace '"url":\s*"[^"]*"', ('"url": "' + $htmlUrl + '"')
$text = $text -replace '"author":\s*"[^"]*"', ('"author": "' + $Author + '"')
[System.IO.File]::WriteAllText($pluginJsonPath, $text, [System.Text.UTF8Encoding]::new($false))
SayStep ("plugin.json updated: url=" + $htmlUrl + "  author=" + $Author)

$licensePath = Join-Path $root "LICENSE"
if (Test-Path $licensePath) {
    $lic = [System.IO.File]::ReadAllText($licensePath, [System.Text.UTF8Encoding]::new($false))
    $lic = $lic -replace 'Copyright \(c\) \d{4} .*', ('Copyright (c) ' + (Get-Date).Year + ' ' + $Author)
    [System.IO.File]::WriteAllText($licensePath, $lic, [System.Text.UTF8Encoding]::new($false))
    SayStep "LICENSE copyright line updated"
}

# ---------------------------------------------------------------- 4. 空仓库激活
#
# 关键：GitHub 的 **Git Data API（blobs / trees / commits）在完全空的仓库上不可用**，
# 会返回 409 `{"message":"Git Repository is empty."}`。
# 而我们正需要这些接口来做首次提交 —— 典型的先有鸡还是先有蛋。
# 解决办法：先用 **Contents API** 提交一个占位文件「激活」仓库，
# 之后 Git Data API 就可用；占位文件不会出现在最终提交的树里。
$refProbe = Invoke-GitHubApi -Method "GET" -Uri "$api/repos/$Owner/$RepoName/git/ref/heads/main" -Body $null
if (-not $refProbe.ok) {
    SayStep "repository is empty, creating an initial commit to activate the Git Data API ..."
    $placeholder = "temporary file used to initialise the repository; removed by the next commit" + [char]10
    $b64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($placeholder))
    $seed = Invoke-GitHubApiWithRetry -Method "PUT" -Uri "$api/repos/$Owner/$RepoName/contents/.gitkeep" -Body @{
        message = "chore: initialise repository"
        content = $b64
        branch  = "main"
    } -Label "bootstrap"
    # 422 = 占位文件已存在（重跑场景），视为已激活
    if (-not $seed.ok -and $seed.status -ne 422) {
        SayWarn ("bootstrap failed: HTTP " + $seed.status + " " + $seed.raw)
        SayFail "could not initialise the empty repository"
    }
    SayStep "repository activated"
}

# ---------------------------------------------------------------- 5. collect files
$skipDirs = @("node_modules", "dist", ".package", ".git", ".vite")
# 以点开头的文件通过 Git Data API 上传会返回 409（保留路径），因此跳过。
$skipFiles = @(".gitignore", ".gitattributes", ".gitmodules", ".npmrc", ".editorconfig")
$script:tracked = @()
function Collect-Files {
    param([string]$Dir)
    foreach ($entry in Get-ChildItem -LiteralPath $Dir -Force) {
        if ($entry.PSIsContainer) {
            if ($skipDirs -contains $entry.Name) { continue }
            Collect-Files -Dir $entry.FullName
        } else {
            if ($skipFiles -contains $entry.Name) { continue }
            if ($entry.Name.StartsWith(".")) { continue }
            $rel = $entry.FullName.Substring($root.Length + 1).Replace("\", "/")
            $script:tracked = $script:tracked + $rel
        }
    }
}
Collect-Files -Dir $root
$tracked = $script:tracked | Sort-Object -Unique
SayStep ("files to upload: " + $tracked.Count)

# ---------------------------------------------------------------- 6. blobs
#
# GitHub 对单个 blob 上传偶发 5xx（实测遇到过 504 Gateway Timeout）。
# 这类错误是**暂时性**的，不能当成失败中止：这里对可重试的状态码做指数退避重试。
function Test-Retryable($status) {
    # 0 = 网络层异常（超时/连接中断），5xx = 服务端暂时不可用，429 = 限流
    return ($status -eq 0 -or $status -eq 429 -or ($status -ge 500 -and $status -le 599))
}

function Invoke-GitHubApiWithRetry {
    param(
        [string]$Method,
        [string]$Uri,
        $Body,
        [int]$MaxAttempts = 5,
        [string]$Label = ""
    )
    $attempt = 0
    while ($true) {
        $attempt++
        $result = Invoke-GitHubApi -Method $Method -Uri $Uri -Body $Body
        if ($result.ok) { return $result }
        if (-not (Test-Retryable $result.status) -or $attempt -ge $MaxAttempts) { return $result }
        $waitMs = [Math]::Min(20000, 1000 * [Math]::Pow(2, $attempt - 1))
        SayWarn ("  temporary failure (HTTP " + $result.status + ") for " + $Label + ", retry " + $attempt + "/" + ($MaxAttempts - 1) + " in " + [int]($waitMs / 1000) + "s")
        Start-Sleep -Milliseconds $waitMs
    }
}

$treeItems = @()
$i = 0
foreach ($rel in $tracked) {
    $i++
    $full = Join-Path $root $rel.Replace("/", "\")
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $content = [System.Convert]::ToBase64String($bytes)
    $blob = Invoke-GitHubApiWithRetry -Method "POST" -Uri "$api/repos/$Owner/$RepoName/git/blobs" -Body @{ content = $content; encoding = "base64" } -Label $rel
    if (-not $blob.ok) {
        SayWarn ("upload failed for: " + $rel)
        SayWarn ("  HTTP " + $blob.status + " -> " + $blob.raw)
        SayFail "blob upload aborted"
    }
    $treeItems += @{ path = $rel; mode = "100644"; type = "blob"; sha = $blob.data.sha }
    if ($i % 10 -eq 0) { SayStep ("  uploaded " + $i + "/" + $tracked.Count) }
}
SayStep "all blobs uploaded"

# ---------------------------------------------------------------- 7. tree + commit
$tree = Invoke-GitHubApiWithRetry -Method "POST" -Uri "$api/repos/$Owner/$RepoName/git/trees" -Body @{ tree = $treeItems } -Label "tree"
if (-not $tree.ok) { SayFail ("create tree: HTTP " + $tree.status + " " + $tree.error) }

$refInfo = Invoke-GitHubApi -Method "GET" -Uri "$api/repos/$Owner/$RepoName/git/ref/heads/main" -Body $null
$parentSha = $null
if ($refInfo.ok) { $parentSha = $refInfo.data.object.sha }

$commitBody = @{ message = ("release: v" + $manifest.version); tree = $tree.data.sha }
if ($null -ne $parentSha) { $commitBody.parents = @($parentSha) }
$commit = Invoke-GitHubApiWithRetry -Method "POST" -Uri "$api/repos/$Owner/$RepoName/git/commits" -Body $commitBody -Label "commit"
if (-not $commit.ok) { SayFail ("create commit: HTTP " + $commit.status + " " + $commit.error) }
SayStep ("commit " + $commit.data.sha.Substring(0, 10) + " created")

# 分支指向新提交。创建分支要幂等：重跑时分支可能已存在（422），改用 PATCH 强制指向。
$ref = Invoke-GitHubApiWithRetry -Method "POST" -Uri "$api/repos/$Owner/$RepoName/git/refs" -Body @{ ref = "refs/heads/main"; sha = $commit.data.sha } -Label "branch"
if ($ref.ok) {
    SayStep "branch main created"
} else {
    $ref = Invoke-GitHubApiWithRetry -Method "PATCH" -Uri "$api/repos/$Owner/$RepoName/git/refs/heads/main" -Body @{ sha = $commit.data.sha; force = $true } -Label "branch"
    if (-not $ref.ok) { SayFail ("update branch: HTTP " + $ref.status + " " + $ref.error) }
    SayStep "branch main updated"
}

# ---------------------------------------------------------------- 8. tag
$tagName = "v" + $manifest.version
$tagObj = Invoke-GitHubApiWithRetry -Method "POST" -Uri "$api/repos/$Owner/$RepoName/git/tags" -Body @{
    tag     = $tagName
    message = "Release " + $tagName
    object  = $commit.data.sha
    type    = "commit"
} -Label "tag"
if ($tagObj.ok) {
    # 标签引用同样要幂等：已存在时改指向新提交，保证重跑后标签始终指向最新
    $tagRef = Invoke-GitHubApiWithRetry -Method "POST" -Uri "$api/repos/$Owner/$RepoName/git/refs" -Body @{ ref = ("refs/tags/" + $tagName); sha = $tagObj.data.sha } -Label "tag-ref"
    if ($tagRef.ok) {
        SayStep ("tag " + $tagName + " created")
    } else {
        $tagRef2 = Invoke-GitHubApiWithRetry -Method "PATCH" -Uri "$api/repos/$Owner/$RepoName/git/refs/tags/$tagName" -Body @{ sha = $tagObj.data.sha; force = $true } -Label "tag-ref"
        if ($tagRef2.ok) { SayStep ("tag " + $tagName + " already existed, moved to the new commit") }
        else { SayWarn ("tag ref not created: HTTP " + $tagRef2.status + " " + $tagRef2.raw) }
    }
} else {
    SayWarn ("tag not created: HTTP " + $tagObj.status + " " + $tagObj.raw)
}

# ---------------------------------------------------------------- 9. summary
Write-Host ""
SayStep "DONE"
Write-Host ("  repository : " + $htmlUrl)
Write-Host ("  package    : " + $manifest.name)
Write-Host ("  commit     : " + $commit.data.sha)
Write-Host ("  version    : " + $tagName)
Write-Host ""
SayWarn "Next: submit the listing to siyuan-note/bazaar (step 5 in PUBLISHING.md) with the values above."
