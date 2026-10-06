/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /**
   * 顺序推进规则：键为动作名，值为允许执行该动作的「前置状态」白名单。
   * 不配置时默认只允许 statuses 中目标状态的前一个状态（禁止跳档）。
   */
  transitions?: Record<string, string[]>
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

/** 动作载荷：确认完工等动作需要随单提交字段，而不是只改一个状态。 */
export type ActionPayload = {
  [field: string]: string
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 检修完工时一次落库的内容。 */
export type MaintenanceCompleteInput = {
  完工日期: string
  更换部件: string
  完工结论: string
}

/** 往期单据归档的一行导入明细。 */
export type ArchiveImportLine = {
  材料编号: string
  来源: string
  材料名称: string
  关联抄表周期: string
  计量点位: string
  用电量: string
  用水量: string
  版本号: string
  形成日期: string
}
