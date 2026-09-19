$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$archivePath = Join-Path (Split-Path -Parent $projectRoot) "easyeda-mcp-$version-source.zip"
if (Test-Path -LiteralPath $archivePath) { throw "Archive already exists: $archivePath" }
$relativeFiles = @('README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json')
foreach ($folder in @('src', 'scripts', 'skills', 'docs', 'examples', 'tests', 'reports/evidence')) {
  $relativeFiles += Get-ChildItem -LiteralPath (Join-Path $projectRoot $folder) -File -Recurse | ForEach-Object { [IO.Path]::GetRelativePath($projectRoot, $_.FullName).Replace('\', '/') }
}
$relativeFiles += @('reports/VALIDATION.md', 'reports/PCB-EDITING-VALIDATION.md', 'reports/live-design.json', 'reports/live-readonly.json', 'reports/live-pcb-editing.json')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($relative in ($relativeFiles | Sort-Object -Unique)) {
    $file = Join-Path $projectRoot $relative
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file, "easyeda-mcp/$relative", [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $archive.Dispose() }
$verify = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $forbidden = $verify.Entries | Where-Object { $_.FullName -match '(node_modules|reports/private|\.easyeda-mcp/|src/tools/|src/agent|legacy-jlc)' }
  if ($forbidden) { throw 'Unexpected private or legacy files in archive' }
  Write-Output "Packaged $($verify.Entries.Count) files: $archivePath"
} finally { $verify.Dispose() }
Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
