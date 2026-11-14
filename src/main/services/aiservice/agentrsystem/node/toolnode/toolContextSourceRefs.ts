import type { ToolContextSourceRef } from '../../state/messageState'

export const extractEntitySourceRefs = (data: Record<string, unknown>): ToolContextSourceRef[] => {
  const refs: ToolContextSourceRef[] = []

  const addCandidate = (candidate: Record<string, unknown>, parentKey?: string): void => {
    const id =
      typeof candidate.entityId === 'string'
        ? candidate.entityId
        : typeof candidate.characterEntityId === 'string'
          ? candidate.characterEntityId
          : typeof candidate.id === 'string' && typeof candidate.type === 'string'
            ? candidate.id
            : undefined
    if (!id) return

    const rawType = candidate.entityType ?? candidate.type
    const entityType = typeof rawType === 'string'
      ? (rawType as ToolContextSourceRef['entityType'])
      : candidate.characterEntityId || parentKey === 'character'
        ? 'character'
        : undefined
    const title = candidate.name ?? candidate.title ?? candidate.label
    refs.push({
      type: 'entity',
      id,
      title: typeof title === 'string' ? title : undefined,
      entityType,
      worldId: typeof candidate.worldId === 'string' ? candidate.worldId : undefined
    })
  }

  const visit = (value: unknown, depth = 0, parentKey?: string): void => {
    if (!value || depth > 4 || refs.length >= 12) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, parentKey)
      return
    }
    if (typeof value !== 'object') return
    const record = value as Record<string, unknown>
    addCandidate(record, parentKey)
    for (const [key, child] of Object.entries(record)) visit(child, depth + 1, key)
  }

  visit(data)
  return [...new Map(refs.map((ref) => [`${ref.type}:${String(ref.id)}`, ref])).values()]
}

export const extractDocumentSourceRefs = (
  data: Record<string, unknown>
): ToolContextSourceRef[] => {
  const refs: ToolContextSourceRef[] = []

  const visit = (value: unknown, depth = 0, parentKey?: string): void => {
    if (!value || depth > 4 || refs.length >= 12) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, parentKey)
      return
    }
    if (typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const id =
      typeof record.documentId === 'string'
        ? record.documentId
        : parentKey === 'document' && typeof record.id === 'string'
          ? record.id
          : undefined
    if (id) {
      const title = record.title ?? record.name
      refs.push({
        type: 'document',
        id,
        title: typeof title === 'string' ? title : undefined,
        worldId: typeof record.worldId === 'string' ? record.worldId : undefined,
        revision: typeof record.revision === 'number' ? record.revision : undefined
      })
    }
    for (const [key, child] of Object.entries(record)) visit(child, depth + 1, key)
  }

  visit(data)
  return [...new Map(refs.map((ref) => [`${ref.type}:${String(ref.id)}`, ref])).values()]
}

export const extractToolSourceRefs = (data: Record<string, unknown>): ToolContextSourceRef[] => [
  ...extractEntitySourceRefs(data),
  ...extractDocumentSourceRefs(data)
]
