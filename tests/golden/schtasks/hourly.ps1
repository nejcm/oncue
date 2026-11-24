# managed-by oncue shape/hourly
Set-Location -LiteralPath '/tmp'
& '/usr/bin/true' 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath 'C:\Users\u\AppData\Local\oncue\shape\hourly.log' -Append -Encoding utf8
exit $LASTEXITCODE
