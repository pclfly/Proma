interface ToolResultContent {
  type: string
  text?: string
}

const EDIT_TEXT_NOT_FOUND_PATTERN = /Could not find (?:edits\[\d+\]|the exact text)/i
const EDIT_AMBIGUOUS_PATTERN = /Found \d+ occurrences[\s\S]*must be unique/i
const MISSING_CLAUDE_MD_PATTERN = /ENOENT[\s\S]*CLAUDE\.md/i

/**
 * Bash 工具返回非零退出码。
 *
 * 形状来自 Pi 的 Bash 工具（`Command exited with code ${exitCode}`）：**命令跑完了**，
 * 只是其中某一步返回了非零。最容易被误读成「工具失败 / 环境坏了」的一类 ——
 * 实测（2026-10-16）一条 `cd … && cat … && ls src` 因为最后那步指向不存在的
 * 目录而报 `Command exited with code 2`，前两步其实都成功了。
 */
const SHELL_NONZERO_EXIT_PATTERN = /Command exited with code \d+/i

/**
 * cmd.exe 语法被交给 Bash 执行。
 *
 * 典型报错 `bash: line 1: cd: too many arguments` —— bash 的 `cd` 不认 cmd 的 `/d`
 * 开关，把它当成多余参数。同类还有 `cd: string not in pwd`（`cd /d` 之外的变体）。
 * 判据只取这几个**只可能来自语法错配**的文案：不能宽到「任何 bash 报错」，
 * 否则真·路径不存在也会被说成「你语法写错了」。
 */
const BASH_CMD_SYNTAX_PATTERN = /cd:\s*(?:too many arguments|string not in pwd|can't cd to)/i

/**
 * PowerShell 里出现 cmd / bash 语法。
 *
 * `dir /b`、`Get-ChildItem /b` 之类会报「无法将参数绑定到参数」或
 * 「The term ... is not recognized」；`/d` 也会被当成非法参数。
 */
const POWERSHELL_FOREIGN_SYNTAX_PATTERN =
  /is not recognized as the name of a cmdlet|The term '.+?' is not recognized|无法将参数绑定到参数|A parameter cannot be found that matches parameter name/i

/**
 * 一批常见的 cmd.exe 专用写法。只用于**在已经有语法错配证据时**把话说具体，
 * 不单独作为触发条件（否则会把正常带 `/` 的参数误判）。
 */
const CMD_ONLY_SYNTAX_PATTERN = /\bcd\s+\/[dD]\b|\bdir\s+\/[a-zA-Z]\b|%[A-Za-z_][A-Za-z0-9_]*%/

export function buildPiToolFailureGuidance(
  toolName: string,
  isError: boolean,
  content: readonly ToolResultContent[],
): string | undefined {
  if (!isError) return undefined

  const errorText = content
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n')
  const normalizedToolName = toolName.trim().toLowerCase()

  if (normalizedToolName === 'edit' && EDIT_TEXT_NOT_FOUND_PATTERN.test(errorText)) {
    return '编辑内容与文件当前文本不一致。请重新 Read 目标文件的相关范围，复制最新且唯一的最小 oldText 后重试；不要因为精确匹配失败而用 Write 覆盖整个已有文件。'
  }
  if (normalizedToolName === 'read' && MISSING_CLAUDE_MD_PATTERN.test(errorText)) {
    return '该工作区规则文件当前不存在，跳过即可。不要继续尝试 cwd 下的 CLAUDE.md、大小写变体或枚举目录；仅在用户明确要求创建或确需沉淀长期工作区规则时才创建它。'
  }

  if (normalizedToolName === 'edit' && EDIT_AMBIGUOUS_PATTERN.test(errorText)) {
    return '旧文本匹配了多处，本次未写入。请重新 Read 相关范围，加入最少的函数名或分支上下文使每个 oldText 唯一；各项针对同一原文件匹配，合并相邻或重叠修改。不要改为全局替换或整文件覆盖。'
  }
  if (normalizedToolName === 'read' && /ENOENT/i.test(errorText)) {
    return '目标路径不存在。请先用 find/目录列表确认实际文件名，再 Read 精确路径；不要猜测相似文件名或为使读取成功而创建空文件。'
  }

  // ── Shell 工具的两类误读（顺序有意：先认「语法错配」，它比非零退出更具体）──
  if (normalizedToolName === 'bash' && BASH_CMD_SYNTAX_PATTERN.test(errorText)) {
    return '这条命令用的是 cmd.exe 语法（`cd /d`、`dir /b`、`%VAR%` 一类），但 Bash 工具由 Git Bash 执行，不认这些写法。改用 bash 语法重试：`cd "D:/路径"`（bash 的 cd 没有 /d；路径含空格时加引号），用 `ls` / `ls -A` 代替 `dir /b`，变量用 `$VAR`。不要在同一轮里再试 cmd 写法。'
  }
  if (normalizedToolName === 'powershell' && POWERSHELL_FOREIGN_SYNTAX_PATTERN.test(errorText)) {
    return '当前是 PowerShell 工具，报错来自 cmd / bash 语法。改用 PowerShell 写法重试：`Get-ChildItem` 代替 `dir /b`，`Set-Location` 代替 `cd /d`，变量用 `$env:VAR`；`&&` 只在 PowerShell 7+ 可用，需要兼容时用 `;` 或分两次调用。'
  }
  if (normalizedToolName === 'bash' || normalizedToolName === 'powershell') {
    if (SHELL_NONZERO_EXIT_PATTERN.test(errorText)) {
      // 语法错配已经在上面拦掉了，这里剩下的就是「某一步非零」
      const cmdHint = normalizedToolName === 'bash' && CMD_ONLY_SYNTAX_PATTERN.test(errorText)
        ? '另外，命令里出现了 cmd.exe 专用写法（`cd /d`、`dir /b`、`%VAR%`），在 Bash 下应换成 bash 语法。'
        : ''
      return `这是 shell 的**非零退出码**，不是工具或环境故障：命令已经执行完，只是链上某一步返回了非零（例如某步的路径不存在，或 \`ls\` 找不到目标）。请先读输出确认是哪一步、该步是否必须成功，再决定下一步；不要因此向用户报告「环境异常」。只做存在性 / 信息性探测时，改用独立调用或 \`|| true\`、\`[ -e 路径 ]\`，不要把可选步骤用 \`&&\` 串在必须成功的链上。${cmdHint}`
    }
    if (normalizedToolName === 'bash' && CMD_ONLY_SYNTAX_PATTERN.test(errorText)) {
      return '命令里出现了 cmd.exe 专用写法（`cd /d`、`dir /b`、`%VAR%` 一类）。Bash 工具由 Git Bash 执行，请改成 bash 语法：`cd "D:/路径"`、`ls`、`$VAR`。'
    }
  }
  return undefined
}
