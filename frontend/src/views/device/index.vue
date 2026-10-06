<template>
  <section class="page" data-module="device">
    <header class="page-head">
      <div>
        <h2>设备台账管理</h2>
        <p class="page-desc">检修完工结论自动写入「保养计划」并生成待保养条目；待保养设备保养闭环后方可复役。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出设备台账清单</button>
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
          <td v-for="column in columns" :key="column">
            <button v-if="column === '设备编号'" class="link" type="button" @click="detailId = Number(row.id)">
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
          <td :colspan="columns.length + 2" class="empty-state">暂无设备台账数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条设备记录 · 检修派生的待保养条目标有来源检修单（见详情）</span>
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
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('device')
const columns = ['设备编号', '设备名称', '设备型号', '所属舱室', '投运日期', '保养周期', '上次保养日', '保养计划']
const actions = ['登记运行', '完成保养', '报废设备']
const ENABLED: Record<string, string[]> = {
  登记运行: ['待保养'],
  完成保养: ['待保养', '运行中'],
  报废设备: ['待保养', '运行中', '已保养'],
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['设备编号', '设备名称', '所属舱室']
const detailId = ref<number | null>(null)

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '运行中设备', value: rows.value.filter((r) => r.status === '运行中').length },
  { label: '待保养设备（复役前必办）', value: rows.value.filter((r) => r.status === '待保养').length },
  { label: '检修派生待保养', value: rows.value.filter((r) => r.status === '待保养' && String(r['来源检修单'] ?? '') !== '').length },
  { label: '已报废设备', value: rows.value.filter((r) => r.status === '已报废').length },
])

function canRun(action: string, status: string) {
  return ENABLED[action].includes(status)
}
function statusClass(status: string) {
  if (status === '已保养') return 'ok'
  if (status === '待保养') return 'warn'
  if (status === '已报废') return 'muted-tag'
  return ''
}
function isEmpty(value: unknown) {
  return value === undefined || value === null || String(value).trim() === ''
}
function resetFilters() {
  filters.value = {}
  reload()
}
function exportRows() {
  downloadEntries(meta.key)
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
function reload() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const payload = listEntries(meta.key, filters.value)
  rows.value = payload.items
  total.value = payload.total
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
</style>
