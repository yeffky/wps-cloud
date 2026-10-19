$ErrorActionPreference = 'Stop'

$jsAddinsRoot = Join-Path $env:APPDATA 'kingsoft\wps\jsaddons'
$publishXmlPath = Join-Path $jsAddinsRoot 'publish.xml'
$pluginNames = @(
    'wps-personal-cloud-addin',
    'wps-personal-cloud-et',
    'wps-personal-cloud-wpp'
)

if (Test-Path -LiteralPath $publishXmlPath -PathType Leaf) {
    try {
        [xml]$xml = Get-Content -LiteralPath $publishXmlPath -Raw
    } catch {
        throw "publish.xml is invalid; no changes were made to avoid affecting other add-ins: $publishXmlPath"
    }
    if ($null -eq $xml.DocumentElement -or $xml.DocumentElement.Name -ne 'jsplugins') {
        throw "publish.xml has no jsplugins root; no changes were made to avoid affecting other add-ins: $publishXmlPath"
    }

    $backup = "$publishXmlPath.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
    Copy-Item -LiteralPath $publishXmlPath -Destination $backup
    $root = $xml.DocumentElement
    foreach ($entry in @($root.SelectNodes('./jsplugin | ./jspluginonline'))) {
        if ($pluginNames -contains $entry.GetAttribute('name')) {
            $null = $root.RemoveChild($entry)
        }
    }
    $xml.Save($publishXmlPath)
}

if (Test-Path -LiteralPath $jsAddinsRoot -PathType Container) {
    foreach ($directory in Get-ChildItem -LiteralPath $jsAddinsRoot -Directory) {
        foreach ($pluginName in $pluginNames) {
            if ($directory.Name.StartsWith("${pluginName}_", [System.StringComparison]::OrdinalIgnoreCase)) {
                Remove-Item -LiteralPath $directory.FullName -Recurse -Force
                break
            }
        }
    }
}

Write-Host 'WPS Personal Cloud add-in uninstalled for the current Windows user. Restart WPS.'
Write-Host 'Repository source, cloud service, server data, and .env were not removed.'
