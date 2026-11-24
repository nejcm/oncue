# managed-by oncue tender/run
$env:PATH = 'C:\Users\u\.bun\bin;C:\Users\u\.local\bin;C:\usr\local\bin;C:\usr\bin;C:\bin'
Set-Location -LiteralPath 'C:\Users\u\Work\agent-workflow'
& 'C:\Users\u\.bun\bin\bun' 'tender.ts' 'run' '--config' 'tender.json' 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath 'C:\Users\u\AppData\Local\oncue\tender\run.log' -Append -Encoding utf8
exit $LASTEXITCODE
