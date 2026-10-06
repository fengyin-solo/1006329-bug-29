<template>
  <section class="page" data-module="archive">
    <header class="page-head">
      <div>
        <h2>往期单据归档</h2>
        <p class="page-desc">
          往期单据按抄表周期搬入；早期纸面件按扫描件编号 PAPER- 建账；重复导入只留最早版；新旧冲突以新版为准、旧版留痕；
          导入明细与能耗台账逐项核对，整批不一致整批打回。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showImport = !showImport">
          {{ showImport ? '收起导入面板' : '批量导入往期单据' }}
        </button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 导入面板 -->
    <div v-if="showImport" class="import-box">
      <div class="import-tools">
        <button class="btn" type="button" @click="loadDemo('ok')">填入：与台账一致的电子件</button>
        <button class="btn" type="button" @click="loadDemo('paper')">填入：纸面扫描件（自动给编号）</button>
        <button class="btn" type="button" @click="loadDemo('dup')">填入：重复导入已存在材料</button>
        <button class="btn" type="button" @click="loadDemo('conflict')">填入：同材料新版（触发仲裁留痕）</button>
        <button class="btn" type="button" @click="loadDemo('mismatch')">填入：与台账数值不符（应打回）</button>
      </div>
      <p class="drawer-sub">每行一条明细，同一批内重复编号自动只留最早一行。</p>
      <div class="import-grid" v-for="(line, i) in lines" :key="i">
        <input v-model="line.材料编号" placeholder="材料编号 / PAPER-扫描件编号" />
        <select v-model="line.来源">
          <option>电子抄表</option>
          <option>纸面扫描件</option>
        </select>
        <input v-model="line.材料名称" placeholder="材料名称" />
        <input v-model="line.关联抄表周期" placeholder="抄表周期 YYYY-MM" />
        <input v-model="line.计量点位" placeholder="计量点位（须与台账一致）" />
        <input v-model="line.用电量" placeholder="用电量" />
        <input v-model="line.用水量" placeholder="用水量" />
        <input v-model="line.版本号" placeholder="版本号" />
        <input v-model="line.形成日期" type="date" />
        <button class="link danger" type="button" @click="lines.splice(i, 1)">删除</button>
      </div>
      <div class="import-actions">
        <button class="btn" type="button" @click="addLine">加一行</button>
        <button class="btn primary" type="button" :disabled="!lines.length" @click="submitImport">校验并导入</button>
      </div>
      <ul v-if="importErrors.length" class="import-errors">
        <li v-for="(err, i) in importErrors" :key="i">{{ err }}</li>
      </ul>
      <p v-if="importReport" class="ok-text">{{ importReport }}</p>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>材料编号/名称</span>
        <input v-model="filters.keyword" placeholder="按材料编号或名称检索" />
      </label>
      <label class="filter-item">
        <span>抄表周期</span>
        <input v-model="filters.cycle" placeholder="如 2026-08" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <button v-if="column === '材料编号'" class="link" type="button" @click="detailId = Number(row.id)">
              {{ row[column] }}
            </button>
            <span v-else :class="{ muted: isEmpty(row[column]) }">{{ isEmpty(row[column]) ? '—' : row[column] }}</span>
          </td>
          <td><span :class="['status-tag', statusClass(row.status)]">{{ row.status }}</span></td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="!canRun(action, row.status)"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无归档材料</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条归档材料 · 仲裁依据：导入时间更晚的新版为准，旧版留痕不删档</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
    </footer>

    <DetailDrawer :open="detailId !== null" :module-key="meta.key" :id="detailId" @close="detailId = null" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import DetailDrawer from '@/components/DetailDrawer.vue'
import { archiveSummary, importArchiveLines, suggestPaperCode } from '@/data/archive'
import { today } from '@/data/maintenance'
import type { ArchiveImportLine, EntryRow } from '@/data/types'

const meta = moduleMeta('archive')
const columns = ['材料编号', '来源', '材料名称', '关联抄表周期', '计量点位', '用电量', '用水量', '版本号', '形成日期', '导入时间']
const actions = ['受理材料', '核对台账', '确认归档']
const ENABLED: Record<string, string[]> = {
  受理材料: ['待办'],
  核对台账: ['办理中'],
  确认归档: ['已核对'],
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({ keyword: '', cycle: '' })
const detailId = ref<number | null>(null)
const showImport = ref(false)
const lines = ref<ArchiveImportLine[]>([])
const importErrors = ref<string[]>([])
const importReport = ref('')

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => {
  const s = archiveSummary()
  return [
    { label: '待办', value: s['待办'] },
    { label: '办理中', value: s['办理中'] },
    { label: '已核对', value: s['已核对'] },
    { label: '已归档', value: s['已归档'] },
    { label: '已留痕（旧版）', value: s['已留痕'] },
  ]
})

function canRun(action: string, status: string) {
  return ENABLED[action].includes(status)
}
function statusClass(status: string) {
  if (status === '已归档') return 'ok'
  if (status === '已留痕') return 'muted-tag'
  if (status === '待办') return 'warn'
  return ''
}
function isEmpty(value: unknown) {
  return value === undefined || value === null || String(value).trim() === ''
}

function addLine() {
  lines.value.push({
    材料编号: '',
    来源: '电子抄表',
    材料名称: '',
    关联抄表周期: '2026-09',
    计量点位: '',
    用电量: '',
    用水量: '',
    版本号: '1',
    形成日期: today(),
  })
}

type DemoKind = 'ok' | 'paper' | 'dup' | 'conflict' | 'mismatch'

function loadDemo(kind: DemoKind) {
  importErrors.value = []
  importReport.value = ''
  if (kind === 'ok') {
    lines.value = [{
      材料编号: 'DOC-202609-E03', 来源: '电子抄表', 材料名称: '综合舱1号电表9月电量确认单',
      关联抄表周期: '2026-09', 计量点位: '综合舱1号电表', 用电量: '1355', 用水量: '0',
      版本号: '1', 形成日期: '2026-10-02',
    }]
  } else if (kind === 'paper') {
    lines.value = [{
      材料编号: suggestPaperCode('2026-08'), 来源: '纸面扫描件', 材料名称: '综合舱2号电表8月电量补抄底单',
      关联抄表周期: '2026-08', 计量点位: '综合舱2号电表', 用电量: '960', 用水量: '0',
      版本号: '1', 形成日期: '2026-09-01',
    }]
  } else if (kind === 'dup') {
    lines.value = [{
      材料编号: 'DOC-202608-E01', 来源: '电子抄表', 材料名称: '综合舱1号电表8月电量单',
      关联抄表周期: '2026-08', 计量点位: '综合舱1号电表', 用电量: '1280', 用水量: '0',
      版本号: '1', 形成日期: '2026-09-01',
    }]
  } else if (kind === 'conflict') {
    lines.value = [{
      材料编号: 'DOC-202608-E01-V2', 来源: '电子抄表', 材料名称: '综合舱1号电表8月电量单',
      关联抄表周期: '2026-08', 计量点位: '综合舱1号电表', 用电量: '1280', 用水量: '0',
      版本号: '2', 形成日期: '2026-09-10',
    }]
  } else {
    lines.value = [{
      材料编号: 'DOC-202609-E04', 来源: '电子抄表', 材料名称: '综合舱1号电表9月电量单（错误数值）',
      关联抄表周期: '2026-09', 计量点位: '综合舱1号电表', 用电量: '9999', 用水量: '0',
      版本号: '1', 形成日期: '2026-10-03',
    }]
  }
}

function submitImport() {
  importErrors.value = []
  const report = importArchiveLines(lines.value.map((line) => ({ ...line })))
  if (report.errors.length) {
    importErrors.value = report.errors
    importReport.value = ''
    return
  }
  importReport.value = `导入完成：新建 ${report.inserted} 条，重复丢弃 ${report.duplicated} 条，旧版留痕 ${report.superseded} 条`
  lines.value = []
  reload()
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  noticeMessage.value = result.message
}
function resetFilters() {
  filters.value = { keyword: '', cycle: '' }
  reload()
}
function exportRows() {
  downloadEntries(meta.key)
}
function reload() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const keyword = filters.value.keyword?.trim() ?? ''
  const cycle = filters.value.cycle?.trim() ?? ''
  let items = listEntries(meta.key).items
  if (keyword) {
    items = items.filter((row) =>
      String(row['材料编号']).includes(keyword) || String(row['材料名称']).includes(keyword),
    )
  }
  if (cycle) {
    items = items.filter((row) => String(row['关联抄表周期']) === cycle)
  }
  rows.value = items
  total.value = items.length
}

onMounted(reload)
</script>

<style scoped>
.muted { color: #94a3b8; }
.ok-text { color: #027a48; }
.status-tag { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #eef2f7; }
.status-tag.ok { background: #ecfdf3; color: #027a48; }
.status-tag.warn { background: #fffaeb; color: #b54708; }
.status-tag.muted-tag { background: #f1f5f9; color: #64748b; }
.row-actions .link:disabled { color: #cbd5e1; cursor: not-allowed; }
.link.danger { color: #b42318; }
.import-box { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
.import-tools { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.drawer-sub { font-size: 12px; color: var(--muted); margin: 0 0 10px; }
.import-grid { display: grid; grid-template-columns: repeat(9, 1fr) 48px; gap: 6px; margin-bottom: 6px; }
.import-grid input, .import-grid select { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 12px; min-width: 0; }
.import-actions { display: flex; gap: 8px; margin: 10px 0; }
.import-errors { margin: 8px 0 0; padding-left: 18px; color: #b42318; font-size: 12px; }
.import-errors li { margin-bottom: 2px; }
</style>
