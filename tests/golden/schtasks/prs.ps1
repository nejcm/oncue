# managed-by oncue tender/prs
$env:PATH = 'C:\Users\u\.bun\bin;C:\Users\u\.local\bin;C:\usr\local\bin;C:\usr\bin;C:\bin'
Set-Location -LiteralPath 'C:\Users\u\Work\agent-workflow'
try {
  & 'C:\Users\u\.bun\bin\bun' 'tender.ts' 'prs' '--config' 'tender.json' 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath 'C:\Users\u\AppData\Local\oncue\tender\prs.log' -Append -Encoding utf8
} catch {
  "$_" | Out-File -LiteralPath 'C:\Users\u\AppData\Local\oncue\tender\prs.log' -Append -Encoding utf8
  exit 1
}
exit $LASTEXITCODE
