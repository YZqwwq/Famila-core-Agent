import type {
  AgentToolRegistryEntry,
  ToolActivationState,
  ToolsetRegistryEntry
} from './toolRegistryTypes'
import {
  listDiscoverableToolsets,
  listEntriesForPhase,
  listEnabledEntries,
  listVisibleEntries,
  toToolMap,
  validateToolRegistry
} from './toolRegistryTypes'
import type { AgentToolPhase } from '../core/agentTool'
import { configureToolsetCatalogProvider, toToolsetCatalogItem } from './toolsetCatalog'
import { toolUsageStatsService } from './toolUsageStatsService'
import { queryToolCatalogTool } from '../tools/utility/queryToolCatalog'
import { activateToolsetTool } from '../tools/utility/activateToolset'
import { getTimeTool } from '../tools/utility/getTime'
import { recallAgentMemoryTool } from '../tools/memory/recallAgentMemory'
import { selectExpressionProfileTool } from '../tools/thinking/selectExpressionProfile'
import { editAgentHabitTool } from '../tools/persona/editAgentHabit'
import { addTool } from '../tools/utility/add'
import { publishAgentArtifactTool } from '../tools/artifact/agentArtifactTools'
import { readAgentArtifactTool } from '../tools/artifact/agentArtifactTools'
import { consultThinkingGuideTool } from '../tools/thinking/consultThinkingGuide'
import { officialWebSearchTool } from '../tools/network/officialWebSearch'
import { getActiveTaskContextTool } from '../tools/task/getActiveTaskContext'
import { getTaskDetailTool } from '../tools/task/getTaskDetail'
import { continueActiveChildAgentTool } from '../tools/task/continueActiveChildAgent'

export const mainAgentToolsets: ToolsetRegistryEntry[] = [
  {
    id: 'network_web_search', title: '联网搜索', summary: '通过 DashScope 搜索公开信息，需要 DashScope 搜索凭据。',
    tags: ['搜索', '网络', 'search'], activationHints: ['需要最新公开信息时'],
    whenToUse: ['查询外部公开信息'], discoverable: true
  },
  {
    id: 'task_runtime', title: '任务运行', summary: '读取和继续当前子 Agent 任务。',
    tags: ['task'], activationHints: [], whenToUse: ['当前有活动任务时'], discoverable: false
  },
  {
    id: 'task_inspection', title: '任务检查', summary: '读取任务、执行、通知和 trace。',
    tags: ['task', '任务'], activationHints: ['需要检查任务详情时'], whenToUse: ['检查任务进度和执行结果'], discoverable: true
  },
  {
    "id": "core_runtime",
    "title": "core_runtime",
    "summary": "工具发现、时间、记忆、表达与长期习惯。",
    "tags": [
      "core_runtime"
    ],
    "activationHints": [],
    "whenToUse": [],
    "discoverable": false
  },
  {
    "id": "utility_math",
    "title": "utility_math",
    "summary": "简单计算。",
    "tags": [
      "utility_math"
    ],
    "activationHints": [],
    "whenToUse": [],
    "discoverable": true
  },
  {
    "id": "agent_artifact",
    "title": "agent_artifact",
    "summary": "保存与读取 Agent 产物。",
    "tags": [
      "agent_artifact"
    ],
    "activationHints": [],
    "whenToUse": [],
    "discoverable": true
  }
]

export const mainAgentToolRegistry: AgentToolRegistryEntry[] = [
  {
    key: consultThinkingGuideTool.name, tool: consultThinkingGuideTool, toolsetId: 'core_runtime',
    category: 'cognitive_guidance', capabilityLayer: 'core', capabilityGroup: '认知辅助',
    capabilitySummary: '按需读取人物分析或剧情讨论的思考维度。', audience: 'main_agent',
    access: 'read', activationMode: 'always', enabled: true, turnCallLimit: 2
  },
  {
    key: officialWebSearchTool.name, tool: officialWebSearchTool, toolsetId: 'network_web_search',
    category: 'network_read', capabilityLayer: 'network', capabilityGroup: '联网搜索',
    capabilitySummary: '通过 DashScope 搜索公开信息；需要配置搜索凭据。', audience: 'main_agent',
    access: 'read', activationMode: 'manual', enabled: true, quickAccessEligible: true,
    quickAccessScope: 'toolset', turnCallLimit: 1
  },
  {
    key: getActiveTaskContextTool.name, tool: getActiveTaskContextTool, toolsetId: 'task_runtime',
    category: 'task_protocol', capabilityLayer: 'sub_agent', capabilityGroup: '任务运行',
    capabilitySummary: '读取当前活动任务和执行队列状态。', audience: 'main_agent',
    access: 'read', activationMode: 'task_context', enabled: true, taskContext: { match: 'active_task' }
  },
  {
    key: continueActiveChildAgentTool.name, tool: continueActiveChildAgentTool, toolsetId: 'task_runtime',
    category: 'task_protocol', capabilityLayer: 'sub_agent', capabilityGroup: '任务运行',
    capabilitySummary: '继续等待用户补充信息的子 Agent 任务。', audience: 'main_agent',
    access: 'control', activationMode: 'task_context', enabled: true, turnCallLimit: 1,
    taskContext: { match: 'active_task', taskStatuses: ['awaiting_user_input'] }
  },
  {
    key: getTaskDetailTool.name, tool: getTaskDetailTool, toolsetId: 'task_inspection',
    category: 'task_inspection', capabilityLayer: 'core', capabilityGroup: '任务检查',
    capabilitySummary: '读取任务、执行、通知和 trace 详情。', audience: 'main_agent',
    access: 'read', activationMode: 'manual', enabled: true, quickAccessEligible: true
  },
  {
    key: queryToolCatalogTool.name,
    tool: queryToolCatalogTool,
    toolsetId: 'core_runtime',
    category: 'tool_discovery',
    capabilityLayer: 'core',
    capabilityGroup: '核心运行',
    capabilitySummary: '查询轻量工具底图，按需发现可激活工具集。',
    audience: 'main_agent',
    access: 'read',
    activationMode: 'always',
    enabled: true
  },
  {
    key: activateToolsetTool.name,
    tool: activateToolsetTool,
    toolsetId: 'core_runtime',
    category: 'tool_activation',
    capabilityLayer: 'core',
    capabilityGroup: '核心运行',
    capabilitySummary: '激活一个或多个工具集，使具体工具在下一轮模型调用中可见。',
    audience: 'main_agent',
    access: 'control',
    activationMode: 'always',
    enabled: true
  },
  {
    key: getTimeTool.name,
    tool: getTimeTool,
    toolsetId: 'core_runtime',
    category: 'utility',
    capabilityLayer: 'core',
    capabilityGroup: '核心运行',
    capabilitySummary:
      '查看当前本地时间；通常 context 已提供时间，只有需要重新确认当前时刻时使用。',
    audience: 'main_agent',
    access: 'read',
    activationMode: 'always',
    enabled: true
  },
  {
    key: recallAgentMemoryTool.name,
    tool: recallAgentMemoryTool,
    toolsetId: 'core_runtime',
    category: 'agent_memory',
    capabilityLayer: 'core',
    capabilityGroup: '核心运行',
    capabilitySummary: '统一回忆待归档消息、阶段记忆与更早原始对话；长期摘要只作为方向提示。',
    audience: 'main_agent',
    access: 'read',
    activationMode: 'always',
    enabled: true,
    turnCallLimit: 1
  },
  {
    key: selectExpressionProfileTool.name,
    tool: selectExpressionProfileTool,
    toolsetId: 'core_runtime',
    category: 'expression_selection',
    capabilityLayer: 'core',
    capabilityGroup: '认知辅助',
    capabilitySummary: '根据 Agent 当前真实情绪选择只在最终组织阶段生效的表达方案。',
    audience: 'main_agent',
    access: 'read',
    activationMode: 'always',
    enabled: true,
    turnCallLimit: 1
  },
  {
    key: editAgentHabitTool.name,
    tool: editAgentHabitTool,
    toolsetId: 'core_runtime',
    category: 'persona_habit',
    capabilityLayer: 'core',
    capabilityGroup: '人格习惯',
    capabilitySummary: '仅根据用户明确的长期要求，设置、替换或忘记 Agent 的持久行为习惯。',
    audience: 'main_agent',
    access: 'write',
    activationMode: 'always',
    enabled: true,
    turnCallLimit: 1
  },
  {
    key: addTool.name,
    tool: addTool,
    toolsetId: 'utility_math',
    category: 'utility',
    capabilityLayer: 'core',
    capabilityGroup: '简单计算',
    capabilitySummary: '执行明确的简单加法计算。',
    audience: 'main_agent',
    access: 'read',
    activationMode: 'manual',
    enabled: true,
    quickAccessEligible: true
  },
  {
    key: publishAgentArtifactTool.name,
    tool: publishAgentArtifactTool,
    toolsetId: 'agent_artifact',
    category: 'agent_artifact',
    capabilityLayer: 'domain',
    capabilityGroup: 'Agent 观点产物',
    capabilitySummary: '将较长观点发布为可点击、可回看的独立产物。',
    audience: 'main_agent',
    access: 'write',
    activationMode: 'always',
    enabled: true,
    turnCallLimit: 2
  },
  {
    key: readAgentArtifactTool.name,
    tool: readAgentArtifactTool,
    toolsetId: 'agent_artifact',
    category: 'agent_artifact',
    capabilityLayer: 'domain',
    capabilityGroup: 'Agent 观点产物',
    capabilitySummary: '按 artifactId 重新读取之前发布的完整观点。',
    audience: 'main_agent',
    access: 'read',
    activationMode: 'manual',
    enabled: true,
    turnCallLimit: 2
  }
]

validateToolRegistry({
  registryName: 'main agent tool registry',
  entries: mainAgentToolRegistry,
  toolsets: mainAgentToolsets,
  allowedAudiences: ['main_agent', 'shared']
})

const entriesByToolset = (toolsetId: string): AgentToolRegistryEntry[] =>
  mainAgentToolRegistry.filter((entry) => entry.enabled && entry.toolsetId === toolsetId)

configureToolsetCatalogProvider(() =>
  listDiscoverableToolsets(mainAgentToolsets).map((toolset) =>
    toToolsetCatalogItem(toolset, entriesByToolset(toolset.id))
  )
)

export const getMainAgentToolEntries = (): AgentToolRegistryEntry[] =>
  listEnabledEntries(mainAgentToolRegistry)

export const hasMainAgentTool = (toolName: string): boolean =>
  getMainAgentToolEntries().some((entry) => entry.key === toolName || entry.tool.name === toolName)

export const getMainAgentToolEntry = (toolName: string): AgentToolRegistryEntry | undefined => {
  const normalizedName = toolName.trim().toLowerCase()
  return getMainAgentToolEntries().find(
    (entry) =>
      entry.key.trim().toLowerCase() === normalizedName ||
      entry.tool.name.trim().toLowerCase() === normalizedName
  )
}

export const getVisibleMainAgentToolEntries = (
  state?: ToolActivationState
): AgentToolRegistryEntry[] => listVisibleEntries(mainAgentToolRegistry, state)

export const getMainAgentToolEntriesForPhase = (
  phase: AgentToolPhase,
  state?: ToolActivationState
): AgentToolRegistryEntry[] =>
  listEntriesForPhase(getVisibleMainAgentToolEntries(state), phase)

export const getVisibleMainAgentToolEntryMap = (
  state?: ToolActivationState
): Record<string, AgentToolRegistryEntry> =>
  Object.fromEntries(
    getVisibleMainAgentToolEntries(state).map((entry) => [entry.tool.name, entry])
  ) as Record<string, AgentToolRegistryEntry>

export const getMainAgentTools = (state?: ToolActivationState) =>
  toToolMap(getVisibleMainAgentToolEntries(state))

export const getMainAgentToolsForPhase = (
  phase: AgentToolPhase,
  state?: ToolActivationState
) => toToolMap(getMainAgentToolEntriesForPhase(phase, state))

const normalize = (value: string): string => value.trim().toLowerCase()

const toolsetById = () => new Map(mainAgentToolsets.map((toolset) => [normalize(toolset.id), toolset]))

const entryByToolName = () => new Map(
  mainAgentToolRegistry.map((entry) => [normalize(entry.tool.name), entry])
)

const uniquePush = (items: string[], value: string): void => {
  const normalized = normalize(value)
  if (!normalized) return
  if (items.some((item) => normalize(item) === normalized)) return
  items.push(value)
}

export const resolveQuickAccessState = async (
  limit = 3
): Promise<Pick<ToolActivationState, 'quickToolsets' | 'quickTools'>> => {
  const stats = await toolUsageStatsService.listTopActivatedTools(limit * 4)
  const quickToolsets: string[] = []
  const quickTools: string[] = []
  let slotCount = 0

  for (const item of stats) {
    if (slotCount >= limit) break

    const entry = entryByToolName().get(normalize(item.toolName))
    if (!entry || !entry.enabled || entry.activationMode !== 'manual') continue
    if (entry.quickAccessEligible === false) continue

    const toolset = toolsetById().get(normalize(entry.toolsetId))
    if (toolset?.quickAccessEligible === false) continue

    const scope = entry.quickAccessScope ?? toolset?.quickAccessScope ?? 'tool'
    if (scope === 'toolset') {
      if (quickToolsets.some((toolsetId) => normalize(toolsetId) === normalize(entry.toolsetId))) {
        continue
      }
      uniquePush(quickToolsets, entry.toolsetId)
    } else {
      if (quickTools.some((toolName) => normalize(toolName) === normalize(entry.tool.name))) {
        continue
      }
      uniquePush(quickTools, entry.tool.name)
    }
    slotCount += 1
  }

  return {
    quickToolsets,
    quickTools
  }
}

export const resolveMainAgentToolActivationState = async (
  state?: ToolActivationState
): Promise<ToolActivationState> => {
  const quick = await resolveQuickAccessState(3)
  return {
    ...state,
    quickToolsets: quick.quickToolsets,
    quickTools: quick.quickTools
  }
}


export function registerAgentTools(entries: AgentToolRegistryEntry[], toolsets: ToolsetRegistryEntry[] = []): void {
  validateToolRegistry({ registryName: 'famila core tools', entries: [...mainAgentToolRegistry, ...entries], toolsets: [...mainAgentToolsets, ...toolsets], allowedAudiences: ['main_agent', 'shared'] })
  mainAgentToolsets.push(...toolsets)
  mainAgentToolRegistry.push(...entries)
}
