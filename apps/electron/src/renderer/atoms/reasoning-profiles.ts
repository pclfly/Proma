import { atom } from 'jotai'
import { setReasoningProfileConfig, type ReasoningProfileConfigData } from '@proma/shared'

const appliedProfilesAtom = atom<string | null>(null)
export const reasoningProfilesRevisionAtom = atom(0)

/** IPC 返回和广播共用；相同快照幂等，revision 使能力缓存失效。 */
export const applyReasoningProfilesAtom = atom(null, (get, set, profiles: ReasoningProfileConfigData[]) => {
  const fingerprint = JSON.stringify(profiles)
  if (get(appliedProfilesAtom) === fingerprint) return
  setReasoningProfileConfig(profiles, { authoritative: true })
  set(appliedProfilesAtom, fingerprint)
  set(reasoningProfilesRevisionAtom, get(reasoningProfilesRevisionAtom) + 1)
})
