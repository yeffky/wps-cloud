$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$addinRoot = Join-Path $repoRoot 'client\addin'
$jsAddinsRoot = Join-Path $env:APPDATA 'kingsoft\wps\jsaddons'
$publishXmlPath = Join-Path $jsAddinsRoot 'publish.xml'

$components = @(
    @{ Package = (Join-Path $addinRoot 'package.json'); Dist = (Join-Path $addinRoot 'dist'); Type = 'wps' },
    @{ Package = (Join-Path $addinRoot 'targets\et\package.json'); Dist = (Join-Path $addinRoot 'targets\et\dist'); Type = 'et' },
    @{ Package = (Join-Path $addinRoot 'targets\wpp\package.json'); Dist = (Join-Path $addinRoot 'targets\wpp\dist'); Type = 'wpp' }
)

$installEntries = foreach ($component in $components) {
    if (-not (Test-Path -LiteralPath $component.Package -PathType Leaf)) {
        throw "Component package not found: $($component.Package)"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $component.Dist 'index.html') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $component.Dist 'main.js') -PathType Leaf)) {
        throw "Missing $($component.Type) build output. Build all three components from client/addin first."
    }

    $package = Get-Content -LiteralPath $component.Package -Raw | ConvertFrom-Json
    [pscustomobject]@{
        Name = $package.name
        Version = $package.version
        Type = $component.Type
        Dist = $component.Dist
        Url = ($package.name + '_' + $package.version)
    }
}

New-Item -ItemType Directory -Path $jsAddinsRoot -Force | Out-Null

if (Test-Path -LiteralPath $publishXmlPath -PathType Leaf) {
    try {
        [xml]$xml = Get-Content -LiteralPath $publishXmlPath -Raw
    } catch {
        throw "Existing publish.xml is invalid; installation stopped to avoid overwriting it: $publishXmlPath"
    }
    if ($null -eq $xml.DocumentElement -or $xml.DocumentElement.Name -ne 'jsplugins') {
        throw "Existing publish.xml has no jsplugins root; installation stopped to avoid overwriting it: $publishXmlPath"
    }
    $backup = "$publishXmlPath.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
    Copy-Item -LiteralPath $publishXmlPath -Destination $backup
} else {
    $xml = New-Object System.Xml.XmlDocument
    $null = $xml.AppendChild($xml.CreateElement('jsplugins'))
}

$root = $xml.DocumentElement
$componentNames = @($installEntries | ForEach-Object { $_.Name })
foreach ($entry in @($root.SelectNodes('./jsplugin | ./jspluginonline'))) {
    if ($componentNames -contains $entry.GetAttribute('name')) {
        $null = $root.RemoveChild($entry)
    }
}

foreach ($entry in $installEntries) {
    $destination = Join-Path $jsAddinsRoot $entry.Url
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Copy-Item -Path (Join-Path $entry.Dist '*') -Destination $destination -Recurse -Force

    $plugin = $xml.CreateElement('jsplugin')
    $plugin.SetAttribute('name', $entry.Name)
    $plugin.SetAttribute('type', $entry.Type)
    $plugin.SetAttribute('url', $entry.Url)
    $plugin.SetAttribute('version', $entry.Version)
    $plugin.SetAttribute('enable', 'enable_dev')
    $plugin.SetAttribute('install', 'null')
    $plugin.SetAttribute('customDomain', '')
    $null = $root.AppendChild($plugin)
}

$xml.Save($publishXmlPath)
Write-Host 'WPS Personal Cloud add-in installed for the current Windows user. Restart WPS.'
Write-Host "Registration file: $publishXmlPath"
