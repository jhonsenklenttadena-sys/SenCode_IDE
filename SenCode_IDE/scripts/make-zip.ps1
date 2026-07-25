$src = "d:\New folder\CodeForge_src"
$out = "d:\New folder\CodeForge_src_for_review.zip"
Remove-Item $out -Force -ErrorAction SilentlyContinue

$include = @("src","electron","scripts","index.html","package.json","postcss.config.js","vite.config.ts","eslint.config.js","tsconfig.app.json","tsconfig.json","CODEFORGE_DOCUMENTATION.md","ELECTRON.md","tailwind.config.js","README.md")
$excludeFiles = @("make-zip.ps1")

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')

foreach ($item in $include) {
    $full = Join-Path $src $item
    if (!(Test-Path $full)) { continue }
    if ((Get-Item $full).PSIsContainer) {
        Get-ChildItem $full -Recurse -File | Where-Object { $excludeFiles -notcontains $_.Name } | ForEach-Object {
            $rel = $_.FullName.Substring($src.Length + 1)
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
        }
    } else {
        $rel = $full.Substring($src.Length + 1)
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $full, $rel) | Out-Null
    }
}

$zip.Dispose()
$sizeMB = [math]::Round((Get-Item $out).Length / 1MB, 2)
Write-Host "Created: $out ($sizeMB MB)"
