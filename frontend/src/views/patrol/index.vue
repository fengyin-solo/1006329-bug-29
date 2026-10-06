<template>
  <section class="page" data-module="patrol">
    <header class="page-head">
      <div>
        <h2>廊内巡检任务</h2>
        <p class="page-desc">待巡检 → 巡检中 → 已上报 → 已完成顺序推进；上报问题自动落入运维值班遗留清单，两处条数一致。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出巡检任务清单</button>
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
            <button v-if="column === '巡检编号'" class="link" type="button" @click="detailId = Number(row.id)">
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
          <td :colspan="columns.length + 2" class="empty-state">暂无巡检任务数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡检任务 · 已上报问题 {{ reportedCount }} 条，与值班遗留清单同源同数</span>
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
import { countPatrolLeftovers } from '@/data/linkage'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('patrol')
const columns = ['巡检编号', '巡检路线', '巡检班组', '计划日期', '完成时间', '发现问题数', '巡检人员']
const actions = ['开始巡检', '上报问题', '确认完成']
const ENABLED: Record<string, string[]> = {
  开始巡检: ['待巡检'],
  上报问题: ['巡检中'],
  确认完成: ['巡检中', '已上报'],
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['巡检编号', '巡检路线', '巡检班组']
const detailId = ref<number | null>(null)

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
// 问题条数的唯一口径来自值班遗留清单，保证巡检入口和值班入口看到的数字一致。
const reportedCount = computed(() => countPatrolLeftovers())
const stats = computed(() => [
  { label: '待巡检任务', value: rows.value.filter((r) => r.status === '待巡检').length },
  { label: '巡检中任务', value: rows.value.filter((r) => r.status === '巡检中').length },
  { label: '已上报待闭环', value: rows.value.filter((r) => r.status === '已上报').length },
  { label: '遗留清单条数', value: reportedCount.value },
])

function canRun(action: string, status: string) {
  return ENABLED[action].includes(status)
}
function statusClass(status: string) {
  if (status === '已完成') return 'ok'
  if (status === '已上报') return 'warn'
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
.status-tag.warn { background: #fef3f2; color: #b42318; }
.row-actions .link:disabled { color: #cbd5e1; cursor: not-allowed; }
</style>
