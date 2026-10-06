import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { completeMaintenance, reportPatrolIssue } from '@/data/linkage'
import { isTerminal, guardTransition } from '@/data/workflow'
import { validateCompleteInput } from '@/data/maintenance'
import type {
  ActionPayload,
  ActionResult,
  EntryRow,
  MaintenanceCompleteInput,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 详情与列表读同一份存储：详情只是按 id 从同一数据源取行，不存在两套口径。 */
export function getEntry(key: string, id: number): EntryRow | null {
  return listRows(key).find((row) => Number(row.id) === Number(id)) ?? null
}

/**
 * 统一动作入口：先过顺序守卫，跳档一律打回并说明卡在哪一段；
 * 特例动作（检修完工、巡检上报）在守卫通过后执行联动落库。
 */
export function runAction(
  key: string,
  id: number,
  action: string,
  payload: ActionPayload = {},
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = rows[index]
  const blocked = guardTransition(key, action, String(current.status))

  // 特例一：检修确认完工（携带完工日期、更换部件、完工结论，一次落库）。
  if (key === 'maintenance' && action === '确认完工') {
    if (current.status === '已完工') {
      // 幂等：同一份记录重复完工只落一次。
      return { ok: true, message: '该检修记录已完工闭环，重复完工未重复落库' }
    }
    if (blocked) {
      return { ok: false, message: blocked }
    }
    const input = payload as unknown as MaintenanceCompleteInput
    const invalid = validateCompleteInput(input)
    if (invalid) {
      return { ok: false, message: invalid }
    }
    const outcome = completeMaintenance(id, input)
    if (typeof outcome === 'string') {
      return { ok: false, message: outcome }
    }
    return {
      ok: true,
      message: `检修记录已完工：状态、完工日期、更换部件一次落库；${outcome.deviceNote}`,
    }
  }

  // 特例二：巡检上报问题，问题同步落入值班遗留清单。
  if (key === 'patrol' && action === '上报问题') {
    if (blocked) {
      return { ok: false, message: blocked }
    }
    const updated: EntryRow = { ...current, status: target, abnormal: true, pending: !isTerminal(key, target) }
    saveRows(key, rows.map((row, i) => (i === index ? updated : row)))
    const note = reportPatrolIssue(updated)
    return { ok: true, message: note }
  }

  if (blocked) {
    return { ok: false, message: blocked }
  }

  const updated: EntryRow = {
    ...current,
    status: target,
    pending: !isTerminal(key, target),
    abnormal: current.abnormal,
  }
  saveRows(key, rows.map((row, i) => (i === index ? updated : row)))
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
