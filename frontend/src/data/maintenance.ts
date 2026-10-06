import type { EntryRow, MaintenanceCompleteInput } from '@/data/types'

/**
 * 检修领域规则（含存量数据的回填裁决）。
 *
 * 【裁决：早年只有完工日期、没有计划工期如何倒推】
 * 以「完工日期」为计划工期末日，按检修类别取标准工期向前倒推，自然日、含首尾：
 *   - 大修：15 天（末日往前 14 天）
 *   - 小修：3 天（末日往前 2 天）
 *   - 常规检修/类别缺失：7 天（末日往前 6 天）
 * 依据：完工日是唯一可信锚点，取「工期末日」不会出现计划末日晚于实际完工的矛盾；
 * 类别工期采用行业常见的检修定额档位，大修占机时间最长、小修最短。
 * 仍在检修中且已超过计划末日的，回写为「已延期」，让账实一致。
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const SCHEDULE_RE = /^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/
export const DEFAULT_DURATION_DAYS = 7

export function today(): string {
  return formatDate(new Date())
}

export function formatDate(date: Date): string {
  const y = String(date.getFullYear())
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function shiftDate(day: string, offsetDays: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + offsetDays)
  return formatDate(date)
}

/** 按检修类别取标准工期天数。 */
export function durationByCategory(category: string): number {
  if (category.includes('大修')) return 15
  if (category.includes('小修')) return 3
  return DEFAULT_DURATION_DAYS
}

/** 以末日为锚点倒推计划工期，自然日含首尾。 */
export function scheduleEndingAt(endDay: string, category: string): string {
  const days = durationByCategory(category)
  return `${shiftDate(endDay, -(days - 1))}~${endDay}`
}

export function scheduleEnd(plan: string): string | null {
  const match = SCHEDULE_RE.exec(String(plan ?? ''))
  return match ? match[2] : null
}

/**
 * 存量检修记录回填：只做一次，幂等（迁移层通过数据版本号保证）。
 * 返回新数组，不修改入参。
 */
export function backfillMaintenanceRows(rows: EntryRow[]): EntryRow[] {
  const now = today()
  return rows.map((row) => {
    const next: EntryRow = { ...row }
    const category = String(next['检修类别'] ?? '')
    const finishDay = String(next['完工日期'] ?? '')
    const validFinish = DATE_RE.test(finishDay)
    const hasSchedule = SCHEDULE_RE.test(String(next['计划工期'] ?? ''))

    if (next.status === '待开工' && !validFinish) {
      // 待开工件：以今日为开工起点预排工期，不给虚假的完工日期。
      if (!hasSchedule) {
        const days = durationByCategory(category)
        next['计划工期'] = `${now}~${shiftDate(now, days - 1)}`
      }
      next['完工日期'] = ''
      return next
    }

    if (!hasSchedule) {
      // 早年记录：有完工日期以完工日为末日；检修中无完工日期以今日为末日倒推（超期即显形）。
      const anchor = validFinish ? finishDay : now
      next['计划工期'] = scheduleEndingAt(anchor, category)
    }

    if (validFinish) {
      // 有完工日期即视为已闭环的存量单据，统一回写为已完工，避免列表/详情两处对不上。
      next.status = '已完工'
      next.pending = false
      next.abnormal = false
    } else if (next.status === '检修中' || next.status === '已延期') {
      const end = scheduleEnd(String(next['计划工期']))
      if (end && end < now) {
        next.status = '已延期'
        next.abnormal = true
        next.pending = true
      }
    }
    return next
  })
}

/** 校验完工表单：状态、完工日期、更换部件一次交齐，缺一打回。 */
export function validateCompleteInput(input: Partial<MaintenanceCompleteInput>): string | null {
  if (!input['完工日期'] || !DATE_RE.test(input['完工日期'])) {
    return '完工必须落完工日期，格式为 YYYY-MM-DD'
  }
  if (!input['更换部件'] || !input['更换部件'].trim()) {
    return '完工必须登记更换部件；未更换部件请填「无」，不允许空着落库'
  }
  if (!input['完工结论'] || !input['完工结论'].trim()) {
    return '完工必须填写完工结论（同步给设备台账保养计划）'
  }
  return null
}
