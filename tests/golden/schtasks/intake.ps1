# managed-by oncue tender/intake
$env:PATH = '/home/u/.bun/bin:/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin'
Set-Location -LiteralPath '/home/u/Work/agent-workflow'
& '/home/u/.bun/bin/bun' 'tender.ts' 'intake' '--config' 'tender.json' 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath 'C:\Users\u\AppData\Local\oncue\tender\intake.log' -Append -Encoding utf8
exit $LASTEXITCODE
