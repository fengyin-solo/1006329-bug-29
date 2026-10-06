import { MODULE_BY_KEY } from '@/data/modules'
import type { EntryRow } from '@/data/types'

/**
 * 顺序流转守卫：所有模块的动作都必须沿 statuses 定义的链路推进。
 * 返回 null 表示放行；否则返回打回原因，页面原样提示「卡在哪一段」。
 */
export function guardTransition(
  moduleKey: string,
  action: string,
  currentStatus: string,
): string | null {
  const meta = MODULE_BY_KEY.get(moduleKey)
  if (!meta) {
    return `没有登记名为 ${moduleKey} 的业务模块`
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return `${meta.entity}没有登记「${action}」这个动作`
  }
  if (currentStatus === target) {
    return `${meta.entity}已经是「${target}」，不用重复操作`
  }
  const allowed = meta.transitions?.[action] ?? defaultAllowed(meta.statuses, target)
  if (allowed.includes(currentStatus)) {
    return null
  }
  const currentIndex = meta.statuses.indexOf(currentStatus)
  const firstAllowedIndex = Math.min(...allowed.map((status) => meta.statuses.indexOf(status)))
  const stage = firstAllowedIndex + 1
  if (currentIndex >= 0 && currentIndex > firstAllowedIndex) {
    return `流转顺序固定：当前在第 ${currentIndex + 1} 段「${currentStatus}」，「${action}」只受理第 ${stage} 段「${allowed.join('/')}」，跳档一律不认`
  }
  return `流转顺序固定：当前卡在第 ${currentIndex >= 0 ? currentIndex + 1 : 1} 段「${currentStatus}」，需先推进到第 ${stage} 段「${allowed.join('/')}」才能${action}`
}

/** 未显式配置 transitions 的模块：只允许从目标状态的前一个状态进入。 */
function defaultAllowed(statuses: string[], target: string): string[] {
  const index = statuses.indexOf(target)
  return index > 0 ? [statuses[index - 1]] : []
}

export function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/** 终态：链路最后一个状态；归档模块中被判冲突失效的「已留痕」同样是终态，不再占用待办。 */
const EXTRA_TERMINAL: Record<string, string[]> = { archive: ['已留痕'] }

export function isTerminal(moduleKey: string, status: string): boolean {
  const meta = MODULE_BY_KEY.get(moduleKey)
  if (!meta) {
    return false
  }
  return (
    meta.statuses[meta.statuses.length - 1] === status ||
    EXTRA_TERMINAL[moduleKey]?.includes(status) === true
  )
}
