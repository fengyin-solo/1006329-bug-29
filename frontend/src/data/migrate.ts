import { MODULES } from './modules'
import type { EntryRow } from './types'

// 存量数据迁移：每次读库时跑一遍，全部幂等（已合规的记录直接跳过），修完即落库。
//
// 迁移一 · 检修记录计划工期回填
//   存量检修记录里「计划工期」缺失或不是标准写法（N天）的一律回填。
//   早年只有完工日期、没有计划工期的记录，按下面的裁决规则倒推：
//     1. 按检修类别套标准工期：大修 15 天、中修 7 天、小修/保养/巡检 3 天；
//     2. 类别辨认不出的取默认标准工期 7 天；
//     3. 已完工且有完工日期的，再按「完工日期 − 标准工期」倒推计划开工日留痕。
//   依据：回填值只作计划基准、不改完工事实；类别标准工期取自运维惯例，默认 7 天
//   与「中修」一致，是各类检修里最接近中位数的档位，偏差最小。
// 迁移二 · 状态字段镜像
//   每个模块最后一个「XX状态」字段与记录当前状态保持一致，列表与详情不会再两处对不上。

const DURATION_PATTERN = /^\d+\s*天$/

const STANDARD_DURATIONS: [string, number][] = [
  ['大修', 15],
  ['中修', 7],
  ['小修', 3],
  ['保养', 3],
  ['巡检', 3],
]

const DEFAULT_DURATION_DAYS = 7

function standardDurationDays(category: string): number {
  for (const [keyword, days] of STANDARD_DURATIONS) {
    if (category.includes(keyword)) {
      return days
    }
  }
  return DEFAULT_DURATION_DAYS
}

function shiftDate(dateText: string, offsetDays: number): string {
  const date = new Date(`${dateText}T00:00:00`)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  date.setDate(date.getDate() + offsetDays)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function backfillMaintenanceDuration(row: EntryRow, today: string): boolean {
  const current = String(row['计划工期'] ?? '').trim()
  if (DURATION_PATTERN.test(current)) {
    return false
  }
  const category = String(row['检修类别'] ?? '')
  const days = standardDurationDays(category)
  row['计划工期'] = `${days}天`
  const finishDate = String(row['完工日期'] ?? '').trim()
  const basis = category ? `按「${category}」标准工期${days}天回填` : `类别不明，按默认标准工期${days}天回填`
  if (finishDate) {
    const plannedStart = shiftDate(finishDate, -days)
    if (plannedStart) {
      row['计划开工日'] = plannedStart
      row['工期回填'] = `${today} ${basis}，由完工日期${finishDate}倒推计划开工日${plannedStart}`
      return true
    }
  }
  row['工期回填'] = `${today} ${basis}`
  return true
}

function mirrorStatusField(row: EntryRow, statusField: string | undefined): boolean {
  if (!statusField) {
    return false
  }
  const status = String(row.status ?? '')
  if (String(row[statusField] ?? '') === status) {
    return false
  }
  row[statusField] = status
  return true
}

export function migrateStore(store: Record<string, EntryRow[]>, today: string): boolean {
  let changed = false
  for (const meta of MODULES) {
    const rows = store[meta.key]
    if (!rows) {
      continue
    }
    const statusField = meta.fields.find((field) => field.endsWith('状态'))
    for (const row of rows) {
      if (meta.key === 'maintenance') {
        changed = backfillMaintenanceDuration(row, today) || changed
      }
      changed = mirrorStatusField(row, statusField) || changed
    }
  }
  return changed
}
