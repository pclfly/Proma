/**
 * 判断 Bash 工具命令是否只读。
 *
 * 该结果同时用于计划模式权限和非 Git 文件基线采集，二者必须保持一致。
 */
export function isBashCommandReadOnly(command: string): boolean {
  if (/(?<![0-9&])>/.test(command)) return false
  if (/\b(rm|rmdir)\s/.test(command)) return false
  if (/\bsed\s+[^|&;]*-i/.test(command)) return false
  if (/\b(chmod|chown|chattr|truncate)\s/.test(command)) return false
  if (/\b(mv|cp|mkdir|touch|mktemp|tee)\s/.test(command)) return false
  if (/\b(npm|pnpm|yarn|bun)\s+(install|i\b|add|remove|uninstall|update|upgrade|link|unlink)\b/.test(command)) return false
  if (/\bpip[23]?\s+(install|uninstall|upgrade)\b/.test(command)) return false
  if (/\b(apt|apt-get|brew|yum|dnf)\s+(install|remove|purge|uninstall|upgrade)\b/.test(command)) return false
  if (/\bgit\s+(commit|push|checkout\s+-[bB]|branch\s+-[mMdD]|merge\b|rebase\b|reset\b|stash\s+(drop|pop)\b|add\b|apply\b|cherry-pick\b)/.test(command)) return false
  if (/\b(kill|killall|pkill)\s/.test(command)) return false
  if (/\b(node|python[23]?|ruby|perl|php|bash|sh|zsh|pwsh|powershell|bun|deno|tsx|ts-node)\b[^|;&\r\n]*\.(js|mjs|cjs|ts|py|ps1|sh|rb|php)(?:["']|\s|$)/i.test(command)) return false
  if (/\b(Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item)\b/i.test(command)) return false
  if (/(?:^|\s)--(?:write|fix)(?:\s|$)/.test(command)) return false
  return true
}
