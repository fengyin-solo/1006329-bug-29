import { SEED_ROWS } from './seed'
import { backfillMaintenanceRows } from './maintenance'
import { isTerminal } from './workflow'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'
const SCHEMA_KEY = 'urban-utility-tunnel:schema'
const CURRENT_SCHEMA = '2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * v1 -> v2：历史数据一次性迁移（幂等，靠 schema 标记只跑一次）。
 * - 检修记录按裁决规则回填计划工期、纠正完工/延期状态；
 * - 其余模块按状态机定义重算 pending，保证看板待办数与链路终态一致。
 */
function migrateV1(parsed: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const result: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(parsed)) {
    if (key === 'maintenance') {
      result[key] = backfillMaintenanceRows(rows)
      continue
    }
    result[key] = rows.map((row) => ({ ...row, pending: !isTerminal(key, String(row.status)) }))
  }
  return result
}

function persist(entries: Record<string, EntryRow[]>, schema: string): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  window.localStorage.setItem(SCHEMA_KEY, schema)
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback, CURRENT_SCHEMA)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const schema = window.localStorage.getItem(SCHEMA_KEY)
    if (schema !== CURRENT_SCHEMA) {
      // 老数据迁移后与新种子合并：新种子里的新模块（如往期单据归档）会补齐。
      const migrated = migrateV1(parsed)
      const merged = { ...fallback, ...migrated }
      persist(merged, CURRENT_SCHEMA)
      return merged
    }
    return { ...fallback, ...parsed }
  } catch {
    persist(fallback, CURRENT_SCHEMA)
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
