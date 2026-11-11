$ErrorActionPreference = 'Stop'
$workerRoot = $PSScriptRoot
$projectRoot = [IO.Path]::GetFullPath((Join-Path $workerRoot '..\..'))
Push-Location $workerRoot
try {
    # Some Python distributions load a bundled certificate during SSLContext
    # construction. Include it when present; ordinary Python needs no extra file.
    $certificate = python -c "import pathlib,ssl; p=pathlib.Path(ssl.__file__).with_name('codex-rejected-cas.pem'); print(p if p.exists() else '')"
    $extraData = @()
    if ($certificate) { $extraData = @('--add-data', "${certificate};.") }
    python -m PyInstaller --noconfirm --clean --onefile --noconsole --name mail_worker @extraData --distpath (Join-Path $projectRoot 'internal\bin') --workpath (Join-Path $workerRoot 'build') --specpath $workerRoot cli.py
    if ($LASTEXITCODE -ne 0) { throw 'Worker build failed.' }
} finally {
    Pop-Location
}
