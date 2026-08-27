/**
 * personal-directive-atoms — 破甲（个人指令）开关的共享响应式状态。
 *
 * 让「破甲开关（PersonalDirectiveToggle）」与「实时拒答检测徽标（ArmorRefusalBadge）」
 * 共用同一个 jotai atom，使切换开关时徽标能即时跟随显示 / 隐藏，
 * 无需重开会话或刷新页面。
 *
 * 约定：
 * - 初始值为 false，由各消费组件在挂载时从 settings 回填（幂等）；
 * - 写入方（开关）在翻转动同时乐观更新本 atom 并持久化到 settings.json；
 * - 读取方（徽标）仅订阅，不持久化。
 */

import { atom } from 'jotai'

/** 破甲指令是否开启（与 settings.json 的 personalDirective.enabled 同步）。 */
export const personalDirectiveEnabledAtom = atom<boolean>(false)
