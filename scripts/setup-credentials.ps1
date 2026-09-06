# scripts/setup-credentials.ps1 —— 仅生成环境变量命令，绝不打印/接收明文 token
# 用法：在 PowerShell 中执行，AI 看不到你输入的明文
param(
  [string]$Actor = 'wangchuan',
  [ValidateSet('sales','manager','presales','exec','finance','contract_admin')]
  [string]$Role = 'sales'
)
Write-Host "请在下一行输入你的 token（明文仅本机内存，不会发送给 AI）：" -ForegroundColor Yellow
$secure = Read-Host -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$token = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
Set-Item Env:\CRM_API_TOKEN $token
Write-Host "已设置环境变量 CRM_API_TOKEN（进程级）。验证前 4 位：" -ForegroundColor Green
Write-Host "前 4 位: $($token.Substring(0,4))  ← 仅把这 4 位回复给 AI 即可"
