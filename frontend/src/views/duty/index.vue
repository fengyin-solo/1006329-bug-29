<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>运维值班交接</h2>
        <p class="page-desc">待交接 → 交接中 → 有遗留 → 已交接顺序闭环；巡检上报的问题自动进入下方遗留清单，条数与巡检入口一致。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出值班交接清单</button>
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
            <button v-if="column === '交接编号'" class="link" type="button" @click="detailId = Number(row.id)">
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
          <td :colspan="columns.length + 2" class="empty-state">暂无值班交接数据</td>
        </tr>
      </tbody>
    </table>

    <section class="leftover-box">
      <h3>遗留清单（巡检上报问题自动落入）</h3>
      <p class="drawer-sub">共 {{ leftoverRows.length }} 条，与巡检页「已上报」问题同一份数据来源。</p>
      <ul v-if="leftoverRows.length" class="leftover-list">
        <li v-for="row in leftoverRows" :key="row.id">
          <strong>{{ row['交接编号'] }}</strong>
          <span>{{ row['值班日期'] }} · {{ row['值班人员'] }}</span>
          <p>{{ row['交接事项'] }}</p>
        </li>
      </ul>
      <p v-else class="empty-state">暂无遗留事项</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条值班记录</span>
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

const meta = moduleMeta('duty')
const columns = ['交接编号', '值班班组', '值班日期', '班次', '值班人员', '交接事项', '交接人员']
const actions = ['发起交接', '登记遗留', '确认交接']
const ENABLED: Record<string, string[]> = {
  发起交接: ['待交接'],
  登记遗留: ['交接中'],
  确认交接: ['交接中', '有遗留'],
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['交接编号', '值班班组', '值班人员']
const detailId = ref<number | null>(null)

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
// 遗留清单统一从带「来源巡检单」标记的记录取，巡检页与本页条数必然一致。
const leftoverRows = computed(() =>
  rows.value.filter((row) => String(row['来源巡检单'] ?? '') !== ''),
)
const stats = computed(() => [
  { label: '待交接班次', value: rows.value.filter((r) => r.status === '待交接').length },
  { label: '交接中班次', value: rows.value.filter((r) => r.status === '交接中').length },
  { label: '有遗留（含巡检转入）', value: rows.value.filter((r) => r.status === '有遗留').length },
  { label: '已交接班次', value: rows.value.filter((r) => r.status === '已交接').length },
])

function canRun(action: string, status: string) {
  return ENABLED[action].includes(status)
}
function statusClass(status: string) {
  if (status === '已交接') return 'ok'
  if (status === '有遗留') return 'warn'
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
.leftover-box { margin-top: 16px; background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
.leftover-box h3 { margin: 0 0 4px; font-size: 14px; }
.drawer-sub { font-size: 12px; color: var(--muted); margin: 0 0 10px; }
.leftover-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.leftover-list li { border-left: 3px solid #b42318; background: #fef3f2; border-radius: 4px; padding: 8px 10px; }
.leftover-list span { font-size: 12px; color: var(--muted); margin-left: 8px; }
.leftover-list p { margin: 4px 0 0; font-size: 13px; }
</style>
