/**
 * 每轮文件改动记录公共入口。
 *
 * 主进程内部只从 `./turn-changes` 导入；导出保持窄面，避免把内部快照
 * 实现细节泄漏到编排层或 IPC。
 */

export { TurnChangeRecorder, getTurnChangeRecorder } from './recorder'
export { resolveToolTargets } from './targets'
export type {
  BeginTurnInput,
  FinishTurnInput,
  NoteToolTargetsInput,
  ToolTargetPhase,
  TurnCaptureFile,
  TurnChangeLimits,
  TurnChangeRecorderOptions,
  TurnChangeSettledListener,
} from './types'
export { captureFileSnapshot, isTextSnapshot, TURN_CHANGE_CAPTURE_LIMITS } from './capture'
export type { CapturedFileKind, CapturedFileSnapshot, CaptureFileOptions } from './capture'
export { compareSnapshots, summarizeEntries, MAX_DIFF_TEXT_BYTES } from './compare'
export type { CompareSnapshotsInput } from './compare'
export { parseGitNumstat } from './numstat'
export type { GitNumstatEntry } from './numstat'
export { GitReader, parseGitStatusZ, runGitCommand } from './git'
export type { GitCommandResult, GitCommandRunner, GitReaderLike, GitReaderOptions, GitRepositorySnapshot } from './git'
export {
  isPathInside,
  isSafeRelativePath,
  joinDisplayPath,
  normalizePathKey,
  relativeToRoot,
  resolveTargetPath,
  toPosixPath,
} from './paths'
