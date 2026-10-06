import { listRows, saveRows } from '@/data/local-store'
import { isTerminal, nextId } from '@/data/workflow'
import type { EntryRow, MaintenanceCompleteInput } from '@/data/types'

/**
 * 跨模块联动规则。
 * 检修完工与设备台账、巡检上报与值班遗留写同一份 localStorage，
 * 任何一处读计数都从被联动方（device / duty）查，保证两个入口条数一致。
 */

/** 从「检修对象」文本里提取设备编号（DEVI-xxxx），匹配不到时不编造设备。 */
export function extractDeviceCode(target: string): string | null {
  const match = /DEVI-\d{4}/.exec(String(target ?? ''))
  return match ? match[0] : null
}

export type CompleteOutcome = {
  row: EntryRow
  deviceNote: string
}

/**
 * 确认完工：状态、完工日期、更换部件、完工结论一次落库；
 * 同步把完工结论写进设备台账「保养计划」并追加一条待保养记录。
 * 调用前已通过顺序守卫；同一记录重复完工只落一次（幂等）。
 */
export function completeMaintenance(id: number, input: MaintenanceCompleteInput): CompleteOutcome | string {
  const rows = listRows('maintenance')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return `没有找到编号为 ${id} 的检修记录`
  }
  const current = rows[index]

  // 幂等：已完工的记录重复点确认完工，直接返回现状，不再重复建待保养。
  if (current.status === '已完工') {
    return {
      row: current,
      deviceNote: '该检修记录已完工闭环，重复完工未重复落库',
    }
  }

  const parts = input['更换部件'].trim()
  const conclusion = input['完工结论'].trim()
  const updated: EntryRow = {
    ...current,
    status: '已完工',
    pending: false,
    abnormal: false,
    '完工日期': input['完工日期'],
    '更换部件': parts,
    '完工结论': conclusion,
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  saveRows('maintenance', nextRows)

  const deviceCode = extractDeviceCode(String(current['检修对象'] ?? ''))
  let deviceNote = '检修对象未标注设备编号（DEVI-xxxx），设备台账未改动'
  if (deviceCode) {
    deviceNote = syncDeviceLedger(deviceCode, updated, conclusion)
  }
  return { row: updated, deviceNote }
}

/** 完工结论写入保养计划，并保证该设备有一条待保养（幂等：同一检修记录只追加一次）。 */
function syncDeviceLedger(deviceCode: string, maintenanceRow: EntryRow, conclusion: string): string {
  const devices = listRows('device')
  const targetIndex = devices.findIndex((row) => String(row['设备编号']) === deviceCode)
  if (targetIndex < 0) {
    return `设备台账中没有编号 ${deviceCode} 的设备，完工结论未能写入保养计划`
  }
  const target = devices[targetIndex]
  const maintenanceNo = String(maintenanceRow['检修编号'] ?? '')
  const next = [...devices]
  const planLine = `检修${maintenanceNo}完工（${maintenanceRow['完工日期']}）：${conclusion}`

  // 已存在同一检修编号派生的待保养记录时不重复追加。
  const exists = devices.some(
    (row) =>
      String(row['设备编号']) === deviceCode &&
      String(row['来源检修单'] ?? '') === maintenanceNo,
  )
  if (!exists) {
    next.push({
      id: nextId(devices),
      status: '待保养',
      pending: true,
      abnormal: false,
      '设备编号': deviceCode,
      '设备名称': target['设备名称'],
      '设备型号': target['设备型号'],
      '所属舱室': target['所属舱室'],
      '投运日期': target['投运日期'],
      '保养周期': target['保养周期'],
      '上次保养日': target['上次保养日'],
      '保养计划': planLine,
      '设备状态': '待保养',
      '来源检修单': maintenanceNo,
    })
  }

  // 原台账行的保养计划也追加结论；若它本身是运行中，置回待保养等待复役后保养。
  const planText = String(target['保养计划'] ?? '')
  const mergedPlan = planText && planText !== '—' ? `${planText}；${planLine}` : planLine
  next[targetIndex] = {
    ...target,
    '保养计划': mergedPlan,
    ...(target.status === '运行中' ? { status: '待保养', pending: true, '设备状态': '待保养' } : {}),
  }
  saveRows('device', next)
  return exists
    ? `设备 ${deviceCode} 的待保养条目此前已生成，本次未重复追加；保养计划已更新完工结论`
    : `设备 ${deviceCode} 已写入保养计划，并新增一条待保养记录，保养闭环后方可复役`
}

/** 巡检上报问题：在值班交接表幂等落一条「有遗留」记录，两个入口条数始终一致。 */
export function reportPatrolIssue(patrolRow: EntryRow): string {
  const patrolNo = String(patrolRow['巡检编号'] ?? '')
  const duties = listRows('duty')
  const exists = duties.some((row) => String(row['来源巡检单'] ?? '') === patrolNo)
  if (exists) {
    return `巡检 ${patrolNo} 的问题已在值班遗留清单，未重复登记`
  }
  const entry: EntryRow = {
    id: nextId(duties),
    status: '有遗留',
    pending: true,
    abnormal: true,
    '交接编号': `DUTY-FROM-${patrolNo}`,
    '值班班组': '巡检转入',
    '值班日期': String(patrolRow['完成时间'] ?? patrolRow['计划日期'] ?? ''),
    '班次': '白班',
    '值班人员': String(patrolRow['巡检人员'] ?? ''),
    '交接事项': `巡检 ${patrolNo} 上报问题，纳入遗留清单跟踪闭环`,
    '交接人员': String(patrolRow['巡检人员'] ?? ''),
    '交接状态': '有遗留',
    '来源巡检单': patrolNo,
  }
  saveRows('duty', [...duties, entry])
  return `巡检 ${patrolNo} 的问题已落入运维值班遗留清单（编号 ${entry['交接编号']}）`
}

/** 遗留清单条数的唯一口径：值班表中来自巡检上报的有遗留记录。 */
export function countPatrolLeftovers(): number {
  return listRows('duty').filter((row) => String(row['来源巡检单'] ?? '') !== '').length
}

/** 重新计算 pending 标记，保证看板待办数与状态一致。 */
export function refreshPending(key: string, rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => ({ ...row, pending: !isTerminal(key, row.status) }))
}
