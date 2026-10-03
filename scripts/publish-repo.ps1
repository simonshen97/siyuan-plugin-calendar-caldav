<#
.SYNOPSIS
    Fill the manifest fields, commit, push and tag the plugin repository.

.DESCRIPTION
    Create an EMPTY public repository on GitHub first, then run this script.
    It will: check git is available; write url/author into plugin.json; update the
    LICENSE copyright line; git init -b main; commit; push to origin/main; create
    and push a v<version> tag; then print the info needed for the marketplace request.

.PARAMETER RepoUrl
    Your public repository URL, e.g. https://github.com/yourname/siyuan-plugin-calendar-caldav

.PARAMETER Author
    Name written into plugin.json author and the LICENSE copyright line.
    Defaults to your git user.name.

.PARAMETER Token
    GitHub Personal Access Token. Only needed together with -CreateRepo.

.PARAMETER CreateRepo
    Let the script create the public repository through the GitHub API.

.EXAMPLE
    .\scripts\publish-repo.ps1 -RepoUrl https://github.com/yourname/siyuan-plugin-calendar-caldav

.EXAMPLE
    .\scripts\publish-repo.ps1 -CreateRepo -Token ghp_xxx -Author "yourname"
#>
[CmdletBinding()]
param(
    [string]$RepoUrl = "",
    [string]$Author = "",
    [string]$Token = "",
    [switch]$CreateRepo
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function SayStep($m) { Write-Host "[publish] $m" -ForegroundColor Cyan }
function SayWarn($m) { Write-Host "[publish] $m" -ForegroundColor Yellow }
function SayFail($m) { Write-Host "[publish] FAILED: $m" -ForegroundColor Red; exit 1 }

SayStep ("workdir: " + $root)

# ---------------------------------------------------------------- 1. preflight
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($null -eq $gitCmd) {
    SayWarn "git not found. Install it first, either:"
    SayWarn "  winget install --id Git.Git -e"
    SayWarn "  or download from https://git-scm.com/download/win"
    SayWarn "Then reopen the terminal and run this script again."
    exit 1
}

$pluginJsonPath = Join-Path $root "plugin.json"
if (-not (Test-Path $pluginJsonPath)) { SayFail "plugin.json not found" }

$manifest = Get-Content $pluginJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
SayStep ("plugin: " + $manifest.name + "  version: " + $manifest.version)

$licensePath = Join-Path $root "LICENSE"
if (-not (Test-Path $licensePath)) { SayWarn "LICENSE file missing" }

# ---------------------------------------------------------------- 2. optional repo creation
if ($CreateRepo) {
    if ($Token -eq "") {
        SayFail "-CreateRepo also needs -Token (GitHub Personal Access Token with repo scope)"
    }
    SayStep ("creating public repository " + $manifest.name + " via GitHub API")
    $payload = @{
        name        = $manifest.name
        private     = $false
        description = "Calendar view for SiYuan with two-way CalDAV sync"
    } | ConvertTo-Json
    $headers = @{
        Authorization = "token " + $Token
        "User-Agent"  = "siyuan-publish"
    }
    try {
        $resp = Invoke-RestMethod -Method Post -Uri "https://api.github.com/user/repos" -Headers $headers -ContentType "application/json" -Body $payload
        $RepoUrl = $resp.clone_url
        SayStep ("repository created: " + $resp.html_url)
    } catch {
        SayFail ("repository creation failed: " + $_.Exception.Message)
    }
}

if ($RepoUrl -eq "") {
    SayWarn "no -RepoUrl given, so the url field and the push are skipped."
    SayWarn "Create an EMPTY public repository at https://github.com/new first"
    SayWarn "(do not tick README / .gitignore / license), then run:"
    $hint = '  .\scripts\publish-repo.ps1 -RepoUrl https://github.com/YOUR_NAME/' + $manifest.name
    SayWarn $hint
}

# ---------------------------------------------------------------- 3. manifest fields
# 署名优先级：-Author 参数 > plugin.json 里已有的真实署名 > git user.name > 占位值
# 注意：不能无条件用 git user.name 覆盖，否则会把已填好的署名打回占位值。
$PLACEHOLDER_AUTHOR = "SiYuan Calendar CalDAV Contributors"
$author = $Author
if ($author -eq "") {
    $existingAuthor = $manifest.author
    if ($existingAuthor -ne "" -and $existingAuthor -ne $PLACEHOLDER_AUTHOR) {
        $author = $existingAuthor
    }
}
if ($author -eq "") {
    $gitName = git config user.name
    if ($LASTEXITCODE -eq 0 -and $gitName -ne "") { $author = $gitName }
}
if ($author -eq "") { $author = $PLACEHOLDER_AUTHOR }

$text = [System.IO.File]::ReadAllText($pluginJsonPath, [System.Text.UTF8Encoding]::new($false))
if ($RepoUrl -ne "") {
    $urlLine = '"url": "' + $RepoUrl + '"'
    $text = $text -replace '"url":\s*"[^"]*"', $urlLine
}
$authorLine = '"author": "' + $author + '"'
$text = $text -replace '"author":\s*"[^"]*"', $authorLine
[System.IO.File]::WriteAllText($pluginJsonPath, $text, [System.Text.UTF8Encoding]::new($false))

$urlShown = $RepoUrl
if ($urlShown -eq "") { $urlShown = "(not set)" }
SayStep ("plugin.json updated: url=" + $urlShown + "  author=" + $author)

if (Test-Path $licensePath) {
    $lic = [System.IO.File]::ReadAllText($licensePath, [System.Text.UTF8Encoding]::new($false))
    $year = (Get-Date).Year.ToString()
    $licLine = "Copyright (c) " + $year + " " + $author
    $lic = $lic -replace 'Copyright \(c\) \d{4} .*', $licLine
    [System.IO.File]::WriteAllText($licensePath, $lic, [System.Text.UTF8Encoding]::new($false))
    SayStep "LICENSE copyright line updated"
}

# ---------------------------------------------------------------- 4. commit and push
$gitDir = Join-Path $root ".git"
if (-not (Test-Path $gitDir)) {
    SayStep "git init ..."
    git init -b main | Out-Null
}

$currentName = git config user.name
if ($LASTEXITCODE -ne 0 -or $currentName -eq "") {
    git config user.name $author
}
$currentMail = git config user.email
if ($LASTEXITCODE -ne 0 -or $currentMail -eq "") {
    SayWarn "git user.email is not set. Run this before committing:"
    SayWarn "  git config --global user.email YOUR_EMAIL"
}

SayStep "staging files (.gitignore excludes node_modules/, dist/, .package/)"
git add -A

$staged = git diff --cached --name-only
if ($null -eq $staged -or $staged.Count -eq 0) {
    SayStep "nothing to commit"
} else {
    $msg = "release: v" + $manifest.version
    SayStep ("commit: " + $msg)
    git commit -m $msg | Out-Null
}

if ($RepoUrl -ne "") {
    $remotes = git remote
    $hasOrigin = $false
    if ($null -ne $remotes) {
        foreach ($r in $remotes) { if ($r -eq "origin") { $hasOrigin = $true } }
    }
    if ($hasOrigin) {
        git remote set-url origin $RepoUrl
    } else {
        git remote add origin $RepoUrl
    }
    SayStep "pushing to origin/main ..."
    git push -u origin main

    $tag = "v" + $manifest.version
    $tags = git tag --list $tag
    if ($null -eq $tags -or $tags.Count -eq 0) {
        git tag -a $tag -m ("v" + $manifest.version)
        SayStep ("tag " + $tag + " created")
    }
    git push origin $tag
    SayStep "tag pushed"
}

# ---------------------------------------------------------------- 5. next steps
$hash = (git rev-parse HEAD).Trim()
Write-Host ""
SayStep "done. The marketplace request needs:"
Write-Host ("  repository : " + $urlShown)
Write-Host ("  package    : " + $manifest.name)
Write-Host ("  commit     : " + $hash)
Write-Host ("  version    : v" + $manifest.version)
Write-Host ""
SayWarn "Next: follow step 5 in PUBLISHING.md to submit the listing to siyuan-note/bazaar."
