# managed-by oncue shape/two-hourly
Set-Location -LiteralPath '/tmp'
& '/usr/bin/true' 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath 'C:\Users\u\AppData\Local\oncue\shape\two-hourly.log' -Append -Encoding utf8
exit $LASTEXITCODE
