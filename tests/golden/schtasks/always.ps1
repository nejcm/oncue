# managed-by oncue shape/always
Set-Location -LiteralPath '/tmp'
& '/usr/bin/true' 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath 'C:\Users\u\AppData\Local\oncue\shape\always.log' -Append -Encoding utf8
exit $LASTEXITCODE
