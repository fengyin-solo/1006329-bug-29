import { listRows, saveRows } from '@/data/local-store'
import { isTerminal, nextId } from '@/data/workflow'
import { today } from '@/data/maintenance'
import type { ArchiveImportLine, EntryRow } from '@/data/types'

/**
 * 往期单据归档规则（导入即建账）。
 *
 * 【按抄表周期搬入】每一行必须带「关联抄表周期」（YYYY-MM），同周期单据成组核对、成组归档。
 * 【纸面件建账】早期只有纸面的，扫描后按扫描件编号 PAPER-<周期>-<顺序号> 建账，来源记「纸面扫描件」。
 *
 * 【重复导入：只留最早那一版】
 * 电子件以「材料编号」为身份键，纸面件以「扫描件编号」为身份键；
 * 同身份键再次导入时直接丢弃，不会多出一行（无论新内容是否一致）。
 *
 * 【新旧两版冲突的仲裁规则】
 * 以「导入时间更晚的新版」为准，旧版只作留痕：
 *   新版进入 待办→办理中→已核对→已归档 正常链路；
 *   旧版置「已留痕」终态，保留原编号、原形成日期与原数值供追溯，不再参与台账核对。
 * 依据：归档的目的是账实一致。后形成/后提交的单据更接近设备与表计当前真实状态，
 * 新版通常包含勘误与复核结论；纸面件存在誊抄误差，电子抄表数据可追溯到采集时刻。
 * 形成日期仅用于排序展示，不用于决定效力——避免旧纸面件仅凭日期早就覆盖新电子件。
 *
 * 【导入明细与台账现状一致】
 * 周期组内每条明细都必须在能耗计量台账中按「计量点位 + 统计周期」找到记录，
 * 且用电量、用水量完全一致；任一条对不上，整批打回（不建账、不留痕），先改台账或撤错误导入。
 */

const CYCLE_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export type ImportReport = {
  inserted: number
  duplicated: number
  superseded: number
  created: EntryRow[]
  errors: string[]
}

type Normalized = ArchiveImportLine & { identity: string; isPaper: boolean }

export function importArchiveLines(lines: ArchiveImportLine[]): ImportReport {
  const report: ImportReport = { inserted: 0, duplicated: 0, superseded: 0, created: [], errors: [] }
  if (!lines.length) {
    report.errors.push('没有可导入的明细行')
    return report
  }

  const normalized: Normalized[] = []
  lines.forEach((line, i) => {
    const pos = `第 ${i + 1} 行（${line.材料编号 || '未填编号'}）`
    if (!line.材料编号 || !line.材料编号.trim()) {
      report.errors.push(`${pos}：缺少材料编号/扫描件编号`)
      return
    }
    if (!line.关联抄表周期 || !CYCLE_RE.test(line.关联抄表周期)) {
      report.errors.push(`${pos}：抄表周期格式应为 YYYY-MM，往期单据按抄表周期搬入`)
      return
    }
    if (!line.计量点位 || !line.用电量 || !line.用水量) {
      report.errors.push(`${pos}：计量点位、用电量、用水量为台账核对项，不能为空`)
      return
    }
    const isPaper = line.来源.includes('纸')
    const identity = isPaper
      ? line.材料编号.trim().toUpperCase()
      : line.材料编号.trim().toUpperCase()
    if (isPaper && !identity.startsWith('PAPER-')) {
      report.errors.push(`${pos}：纸面件必须使用扫描件编号（PAPER- 开头）`)
      return
    }
    normalized.push({ ...line, identity, isPaper })
  })
  if (report.errors.length) {
    return report
  }

  // 同一批内自身重复也只留最早一行。
  const batchSeen = new Set<string>()
  const deduped = normalized.filter((line) => {
    if (batchSeen.has(line.identity)) {
      report.duplicated += 1
      report.errors.push(`材料 ${line.identity} 在本次导入中重复，只保留最早一行`)
      return false
    }
    batchSeen.add(line.identity)
    return true
  })

  // 账实一致：按「计量点位 + 抄表周期」与能耗台账核对，任一对不上整批打回。
  const energy = listRows('energy')
  for (const line of deduped) {
    const ledger = energy.find(
      (row) =>
        String(row['计量点位']) === line.计量点位 &&
        String(row['统计周期']) === line.关联抄表周期,
    )
    if (!ledger) {
      report.errors.push(
        `${line.identity}：能耗台账缺少点位「${line.计量点位}」${line.关联抄表周期} 的记录，整批打回`,
      )
      continue
    }
    if (String(ledger['用电量']) !== line.用电量 || String(ledger['用水量']) !== line.用水量) {
      report.errors.push(
        `${line.identity}：与台账现值不一致（台账 用电${ledger['用电量']}/用水${ledger['用水量']}，导入 用电${line.用电量}/用水${line.用水量}），整批打回`,
      )
    }
  }
  if (report.errors.length) {
    return report
  }

  const rows = listRows('archive')
  const byIdentity = new Map(rows.map((row) => [String(row['材料编号']).toUpperCase(), row]))
  const next = [...rows]
  const stamp = today()

  for (const line of deduped) {
    const existing = byIdentity.get(line.identity)
    if (existing) {
      // 同一份材料重复导入：只留最早那一版，不会多出一行。
      report.duplicated += 1
      continue
    }
    const version = Number(line.版本号) || 1
    const family = findSameMaterialFamily(rows, line)
    if (family) {
      // 新旧两版冲突：以导入时间更晚的新版为准，旧版留痕。
      const oldVersion = Number(family['版本号']) || 1
      const familyIndex = next.findIndex((row) => row.id === family.id)
      if (version >= oldVersion || stamp >= String(family['导入时间'])) {
        next[familyIndex] = { ...family, status: '已留痕', pending: false, abnormal: false }
        report.superseded += 1
      } else {
        // 导入的是更早旧版：旧版不覆盖新版，直接留痕丢弃。
        report.duplicated += 1
        next.push(buildRow(rows, line, stamp, '已留痕', false))
        report.created.push(next[next.length - 1])
        continue
      }
    }
    const row = buildRow(next, line, stamp, '待办', true)
    next.push(row)
    byIdentity.set(line.identity, row)
    report.inserted += 1
    report.created.push(row)
  }

  saveRows('archive', next)
  return report
}

/** 同物不同号：按「材料名称 + 关联抄表周期 + 计量点位」识别新旧版本家族。 */
function findSameMaterialFamily(rows: EntryRow[], line: Normalized): EntryRow | undefined {
  return rows.find(
    (row) =>
      row.status !== '已留痕' &&
      String(row['材料名称']) === line.材料名称 &&
      String(row['关联抄表周期']) === line.关联抄表周期 &&
      String(row['计量点位']) === line.计量点位,
  )
}

function buildRow(
  rows: EntryRow[],
  line: Normalized,
  stamp: string,
  status: string,
  pending: boolean,
): EntryRow {
  return {
    id: nextId(rows),
    status,
    pending,
    abnormal: false,
    '材料编号': line.identity,
    '来源': line.isPaper ? '纸面扫描件' : line.来源 || '电子抄表',
    '材料名称': line.材料名称,
    '关联抄表周期': line.关联抄表周期,
    '计量点位': line.计量点位,
    '用电量': line.用电量,
    '用水量': line.用水量,
    '版本号': line.版本号 || '1',
    '形成日期': line.形成日期 || stamp,
    '导入时间': stamp,
    '归档状态': status,
  }
}

/** 纸面件扫描编号建议：PAPER-周期-顺序号。 */
export function suggestPaperCode(cycle: string): string {
  const count = listRows('archive').filter(
    (row) => String(row['材料编号']).startsWith(`PAPER-${cycle}-`),
  ).length
  return `PAPER-${cycle}-${String(count + 1).padStart(3, '0')}`
}

/** 待办/办理中/已核对/已归档/已留痕 计数统一从此处取，页面两处条数一致。 */
export function archiveSummary() {
  const rows = listRows('archive')
  const count = (status: string) => rows.filter((row) => row.status === status).length
  const pendingCount = rows.filter((row) => !isTerminal('archive', row.status)).length
  return {
    待办: count('待办'),
    办理中: count('办理中'),
    已核对: count('已核对'),
    已归档: count('已归档'),
    已留痕: count('已留痕'),
    待处理: pendingCount,
  }
}
