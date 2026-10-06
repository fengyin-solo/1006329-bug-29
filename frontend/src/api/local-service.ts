import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAll, saveRows } from '@/data/local-store'
import type {
  ActionPayload,
  ActionResult,
  EntryRow,
  ImportResult,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走 / 偏离计划」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = [
  '撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚',
  '延期', '逾期', '超标', '异常', '故障', '损坏', '预警', '返工', '遗留', '取消', '报废', '问题',
]

// 已经办结归档、不再有待办的状态：除了各模块的「好终态」，还有这几个坏终态也算归档。
const ARCHIVED_STATUSES = new Set(['已停用', '已报废', '已取消', '已迁出'])

function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextCode(rows: EntryRow[], field: string, prefix: string): string {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`)
  const max = rows.reduce((acc, row) => {
    const matched = pattern.exec(String(row[field] ?? ''))
    return matched ? Math.max(acc, Number(matched[1])) : acc
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

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

// 详情与列表读同一份本地库，不存在两套数据，两处一定对得上。
export function getEntry(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === id)
}

// 当前状态下允许执行的动作：页面只渲染这些按钮，顺序之外的动作根本递不进来。
export function availableActions(key: string, row: EntryRow): string[] {
  const meta = moduleMeta(key)
  const current = String(row.status)
  return meta.actions.filter((action) => (meta.actionSources[action] ?? []).includes(current))
}

function isTerminal(meta: ModuleMeta, status: string): boolean {
  return meta.statuses.slice(2).includes(status)
}

function isPending(meta: ModuleMeta, status: string): boolean {
  if (ARCHIVED_STATUSES.has(status)) {
    return false
  }
  // 还有可推进的动作就是待办；没有任何动作可走（含好终态）就是已办结。
  return meta.actions.some((action) => (meta.actionSources[action] ?? []).includes(status))
}

function appendTrace(row: EntryRow, action: string, current: string, target: string): EntryRow {
  // 从终态改办（改判/延期后完工等）：新结论为准，旧结论只留痕。
  const trace = `${todayText()} 由「${current}」改办「${action}」→「${target}」，「${current}」结论仅留痕不作准`
  const previous = String(row['流转留痕'] ?? '')
  return { ...row, 流转留痕: previous ? `${previous}；${trace}` : trace }
}

export function runAction(key: string, id: number, action: string, payload: ActionPayload = {}): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const store = allRows()
  const rows = [...(store[key] ?? [])]
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，同一记录不重复办理、不重复落库` }
  }
  const sources = meta.actionSources[action] ?? []
  if (!sources.includes(current)) {
    const code = String(rows[index][meta.fields[0]] ?? id)
    const need = sources.map((status) => `「${status}」`).join('或')
    return { ok: false, message: `「${code}」当前卡在「${current}」段：「${action}」需从${need}推进，跳档一律打回` }
  }

  const statusField = meta.fields.find((field) => field.endsWith('状态'))
  let updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: isPending(meta, target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.includes(verb)),
  }
  if (statusField) {
    updated[statusField] = target
  }
  if (isTerminal(meta, current)) {
    updated = appendTrace(updated, action, current, target)
  }
  rows[index] = updated

  if (key === 'maintenance' && action === '确认完工') {
    return completeMaintenance(store, rows, index, payload)
  }
  if (key === 'patrol' && action === '上报问题') {
    return reportPatrolProblem(store, rows, updated)
  }
  saveAll({ ...store, [key]: rows })
  const traced = isTerminal(meta, current) ? `；原「${current}」结论已留痕，以「${target}」为准` : ''
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${traced}` }
}

// 检修完工事务：状态、完工日期、更换部件、完工结论一次落库；
// 同事务把完工结论写进设备台账的保养计划（新增一条待保养），整库只写一次。
// 幂等：已完工的记录在顺序校验处就被打回；设备台账按来源检修编号去重，重复完工不会落第二次。
function completeMaintenance(
  store: Record<string, EntryRow[]>,
  rows: EntryRow[],
  index: number,
  payload: ActionPayload,
): ActionResult {
  const today = todayText()
  const finishDate = (payload['完工日期'] ?? '').trim() || today
  if (!/^\d{4}-\d{2}-\d{2}$/.test(finishDate)) {
    return { ok: false, message: '完工日期格式应为 YYYY-MM-DD，未做任何落库' }
  }
  const parts = (payload['更换部件'] ?? '').trim()
  if (!parts) {
    return { ok: false, message: '确认完工必须填写更换部件（未更换请填「无」），未做任何落库' }
  }
  const row = rows[index]
  const conclusion = (payload['完工结论'] ?? '').trim() || `${String(row['检修类别'] ?? '检修')}完工，验收合格`
  const completed: EntryRow = {
    ...row,
    完工日期: finishDate,
    更换部件: parts,
    完工结论: conclusion,
  }
  rows[index] = completed

  const deviceRows = [...(store['device'] ?? [])]
  const maintenanceCode = String(completed['检修编号'] ?? '')
  let deviceMessage: string
  if (deviceRows.some((device) => device['来源检修编号'] === maintenanceCode)) {
    deviceMessage = '设备台账已存在该检修单的保养计划，未重复添加'
  } else {
    const deviceCode = nextCode(deviceRows, '设备编号', 'DEVI')
    deviceRows.push({
      id: nextId(deviceRows),
      status: '待保养',
      pending: true,
      abnormal: false,
      设备编号: deviceCode,
      设备名称: `${String(completed['检修对象'] ?? '检修对象')}（检修后保养）`,
      设备型号: String(completed['检修类别'] ?? '—'),
      所属舱室: '—',
      投运日期: '—',
      保养周期: '按完工结论',
      上次保养日: finishDate,
      设备状态: '待保养',
      保养计划: `完工结论：${conclusion}；更换部件：${parts}；来源检修单：${maintenanceCode}`,
      来源检修编号: maintenanceCode,
    })
    deviceMessage = `设备台账新增待保养「${deviceCode}」，完工结论已写入保养计划`
  }
  saveAll({ ...store, maintenance: rows, device: deviceRows })
  return { ok: true, message: `检修记录已完工：状态、完工日期、更换部件一次落库；${deviceMessage}` }
}

// 巡检上报问题：同一事务里把遗留事项落到值班交接的遗留清单，
// 按来源巡检编号去重，上报数与遗留清单条数两处始终一致。
function reportPatrolProblem(
  store: Record<string, EntryRow[]>,
  rows: EntryRow[],
  updated: EntryRow,
): ActionResult {
  const dutyRows = [...(store['duty'] ?? [])]
  const patrolCode = String(updated['巡检编号'] ?? '')
  let linkMessage: string
  if (dutyRows.some((duty) => duty['来源巡检编号'] === patrolCode)) {
    linkMessage = '值班遗留清单已存在对应条目，未重复添加'
  } else {
    const dutyCode = nextCode(dutyRows, '交接编号', 'DUTY')
    dutyRows.push({
      id: nextId(dutyRows),
      status: '有遗留',
      pending: true,
      abnormal: true,
      交接编号: dutyCode,
      值班班组: String(updated['巡检班组'] ?? '—'),
      值班日期: todayText(),
      班次: '—',
      值班人员: String(updated['巡检人员'] ?? '—'),
      交接事项: `巡检${patrolCode}上报：${String(updated['巡检路线'] ?? '')}发现${String(updated['发现问题数'] ?? '若干')}处问题，待跟进处置`,
      交接人员: '—',
      交接状态: '有遗留',
      来源巡检编号: patrolCode,
    })
    linkMessage = `遗留事项已同步到值班交接「${dutyCode}」`
  }
  saveAll({ ...store, patrol: rows, duty: dutyRows })
  return { ok: true, message: `巡检任务已上报，当前状态「已上报」；${linkMessage}，上报数与遗留清单条数一致` }
}

// 巡检上报 ↔ 值班遗留清单的对账口径：两处读同一份本地库，条数天然一致。
export function backlogSummary(): { reported: number; backlog: number; items: EntryRow[] } {
  const reported = listRows('patrol').filter((row) => row.status === '已上报').length
  const items = listRows('duty').filter((row) => String(row['来源巡检编号'] ?? '') !== '')
  return { reported, backlog: items.length, items }
}

function importKeyOf(row: EntryRow): string {
  const scan = String(row['扫描件编号'] ?? '').trim()
  if (scan) {
    return `scan:${scan}`
  }
  return `period:${String(row['计量点位'] ?? '').trim()}|${String(row['统计周期'] ?? '').trim()}`
}

// 往期单据搬入：电子单据按「计量点位+统计周期」建账，早期纸面单据按「扫描件编号」建账。
// 仲裁规则：同一份材料重复导入，以最早入帐那一版为准——先入帐的一版最接近抄表/扫描的
// 原始凭证时点，后续重复导入视为重复报送而非更正，只留痕不多出行；要更正走改判链路。
export function importEnergyEntries(text: string): ImportResult {
  const result: ImportResult = { ok: true, message: '', imported: 0, duplicated: 0, conflicted: 0, rejected: 0 }
  const store = allRows()
  const rows = [...(store['energy'] ?? [])]
  const byKey = new Map<string, EntryRow>()
  for (const row of rows) {
    byKey.set(importKeyOf(row), row)
  }
  const today = todayText()
  const newRows: EntryRow[] = []
  let codeSeq = rows.length

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const cells = line.split(/[,，]/).map((cell) => cell.trim())
    if (cells[0] === '计量编号') {
      continue
    }
    const [code, point, power, water, period, reader, readDate, scan] = cells
    if (!point || (!period && !scan) || (readDate && !/^\d{4}-\d{2}-\d{2}$/.test(readDate))) {
      result.rejected += 1
      continue
    }
    const key = scan ? `scan:${scan}` : `period:${point}|${period}`
    const existing = byKey.get(key)
    if (existing) {
      // 判定时把空值与占位「—」视为等同，避免同一行被误判成冲突。
      const norm = (value: unknown) => {
        const text = String(value ?? '').trim()
        return text === '—' ? '' : text
      }
      const identical =
        norm(existing['用电量']) === norm(power) &&
        norm(existing['用水量']) === norm(water) &&
        norm(existing['抄表日期']) === norm(readDate)
      if (identical) {
        result.duplicated += 1
      } else {
        result.conflicted += 1
        const trace = `${today} 重复导入与台账现存版本不一致，以最早入帐版为准，导入版仅留痕：用电量${power || '—'}/用水量${water || '—'}/抄表日期${readDate || '—'}`
        const previous = String(existing['导入留痕'] ?? '')
        existing['导入留痕'] = previous ? `${previous}；${trace}` : trace
      }
      continue
    }
    codeSeq += 1
    const row: EntryRow = {
      id: nextId(rows.concat(newRows)),
      status: '已核对',
      pending: false,
      abnormal: false,
      计量编号: code || `ENER-${String(codeSeq).padStart(4, '0')}`,
      计量点位: point,
      用电量: power || '—',
      用水量: water || '—',
      统计周期: period || '—',
      抄表人员: reader || '—',
      抄表日期: readDate || today,
      计量状态: '已核对',
      建账方式: scan ? '扫描件建账' : '抄表周期搬入',
      扫描件编号: scan || '',
      导入日期: today,
    }
    byKey.set(key, row)
    newRows.push(row)
    result.imported += 1
  }

  if (result.imported + result.duplicated + result.conflicted + result.rejected === 0) {
    return { ...result, ok: false, message: '没有可导入的内容：每行一条，逗号分隔，顺序为 计量编号,计量点位,用电量,用水量,统计周期,抄表人员,抄表日期,扫描件编号(可空)' }
  }
  saveAll({ ...store, energy: [...rows, ...newRows] })
  result.message = `往期单据搬入完成：新建账 ${result.imported} 条，重复忽略 ${result.duplicated} 条，冲突留痕 ${result.conflicted} 条，格式驳回 ${result.rejected} 条。同一份材料只留最早一版，台账未多出一行`
  return result
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
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
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
