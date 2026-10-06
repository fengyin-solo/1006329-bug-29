<template>
  <section class="page" data-module="energy">
    <header class="page-head">
      <div>
        <h2>廊内能耗计量管理</h2>
        <p class="page-desc">
          维护能耗计量记录。往期单据按抄表周期搬入建账，早期纸面单据按扫描件编号建账；
          同一份材料重复导入只留最早一版，不多出一行。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showImport = !showImport">导入往期单据</button>
        <button class="btn" type="button" @click="exportRows">导出廊内能耗计量清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in liveStats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section v-if="showImport" class="import-panel">
      <h3>往期单据搬入</h3>
      <p class="modal-tip">
        每行一条，逗号分隔：计量编号,计量点位,用电量,用水量,统计周期,抄表人员,抄表日期,扫描件编号(纸面单据必填)。
        电子单据按「计量点位+统计周期」建账，纸面单据按「扫描件编号」建账；重复导入以最早入帐版为准，导入版仅留痕。
      </p>
      <textarea v-model="importText" rows="6" placeholder="ENER-202605-A,综合舱东段1#电表,1320,46,2026-05,王抄表,2026-06-01,"></textarea>
      <div class="modal-actions">
        <button class="btn primary" type="button" @click="runImport">执行导入</button>
        <button class="btn" type="button" @click="loadSample">载入示例往期单据</button>
        <button class="btn ghost" type="button" @click="showImport = false">收起</button>
      </div>
      <p v-if="importMessage" class="notice-text">{{ importMessage }}</p>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
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
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in rowActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无廊内能耗计量数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条廊内能耗计量记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  availableActions,
  downloadEntries,
  importEnergyEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('energy')
const columns = ["计量编号", "计量点位", "用电量", "用水量", "统计周期", "抄表人员", "抄表日期", "计量状态"]
const statuses = ["待抄表", "已抄表", "已核对", "数据异常"]

const SAMPLE_IMPORT = [
  '计量编号,计量点位,用电量,用水量,统计周期,抄表人员,抄表日期,扫描件编号',
  'ENER-202605-A,综合舱东段1#电表,1320,46,2026-05,王抄表,2026-06-01,',
  'ENER-202605-A,综合舱东段1#电表,1320,46,2026-05,王抄表,2026-06-01,',
  'ENER-202604-A,综合舱东段1#电表,1288,41,2026-04,王抄表,2026-05-01,',
  'ENER-202609-X,综合舱东段1#电表,1450,44,2026-09,王抄表,2026-10-01,',
  'ENER-202303-B,综合舱西段2#水表,,38,2023-03,李抄表,2023-04-01,SCAN-2023-0117',
  'ENER-202303-B,综合舱西段2#水表,,38,2023-03,李抄表,2023-04-01,SCAN-2023-0117',
].join('\n')

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const showImport = ref(false)
const importText = ref('')
const importMessage = ref('')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const liveStats = computed(() => [
  { label: '待抄表点位', value: rows.value.filter((row) => row.status === '待抄表').length },
  { label: '已核对点位', value: rows.value.filter((row) => row.status === '已核对').length },
  { label: '数据异常点位', value: rows.value.filter((row) => row.status === '数据异常').length },
])

function rowActions(row: EntryRow) {
  return availableActions(meta.key, row)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function loadSample() {
  importText.value = SAMPLE_IMPORT
  importMessage.value = '示例已载入：含重复行、与台账冲突行、纸面扫描件行，可直接执行导入看效果。'
}

function runImport() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = importEnergyEntries(importText.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  importMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '廊内能耗计量列表读取失败'
  }
}

onMounted(reload)
</script>
