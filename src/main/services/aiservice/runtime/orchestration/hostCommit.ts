import type { EntityManager } from 'typeorm'
type CommitHook = (manager: EntityManager, changeSetId: string) => Promise<unknown>
let hook: CommitHook | undefined
export const configureHostCommit = (value: CommitHook): void => { hook = value }
export async function commitHostChangeSet(manager: EntityManager, changeSetId: string): Promise<void> {
  await hook?.(manager, changeSetId)
}
