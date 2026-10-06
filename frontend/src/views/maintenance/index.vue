<template>
  <section class="page" data-module="maintenance">
    <header class="page-head">
      <div>
        <h2>设施检修管理</h2>
        <p class="page-desc">
          检修链路固定为 待开工 → 检修中 → 已完工（检修中可申请延期，延期后仍须完工归档）；
          跳档一律打回。确认完工时状态、完工日期、更换部件一次落库，并同步设备台账保养计划。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出设施检修管理清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in liveStats" :key="item.label" class="stat-card">
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
            <button class="link" type="button" @click="openDetail(row)">详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无设施检修管理数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条设施检修管理记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="finishTarget" class="modal-mask" @click.self="finishTarget = null">
      <form class="modal-card" @submit.prevent="submitFinish">
        <h3>确认完工 · {{ finishTarget['检修编号'] }}</h3>
        <p class="modal-tip">状态、完工日期、更换部件将一次落库；完工结论同步写入设备台账保养计划（新增一条待保养）。</p>
        <label class="modal-field">
          <span>完工日期</span>
          <input v-model="finishForm.完工日期" type="date" required />
        </label>
        <label class="modal-field">
          <span>更换部件（未更换请填「无」）</span>
          <input v-model="finishForm.更换部件" placeholder="如：轴承×2、密封圈×1" required />
        </label>
        <label class="modal-field">
          <span>完工结论</span>
          <textarea v-model="finishForm.完工结论" rows="3" placeholder="检修结果与验收结论"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn primary" type="submit">落库完工</button>
          <button class="btn ghost" type="button" @click="finishTarget = null">取消</button>
        </div>
      </form>
    </div>

    <div v-if="detailRow" class="modal-mask" @click.self="detailRow = null">
      <div class="modal-card">
        <h3>检修详情 · {{ detailRow['检修编号'] }}</h3>
        <p class="modal-tip">详情与列表读同一份本地库，两处必然一致。</p>
        <dl class="detail-list">
          <template v-for="field in detailFields" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ detailRow[field] || '—' }}</dd>
          </template>
        </dl>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="detailRow = null">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  availableActions,
  downloadEntries,
  getEntry,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('maintenance')
const columns = ["检修编号", "检修对象", "检修类别", "检修班组", "计划工期", "完工日期", "更换部件", "检修状态"]
const statuses = ["待开工", "检修中", "已完工", "已延期"]
const detailFields = [
  "检修编号", "检修对象", "检修类别", "检修班组", "计划工期", "计划开工日", "完工日期",
  "更换部件", "完工结论", "检修状态", "延期说明", "工期回填", "流转留痕",
]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const finishTarget = ref<EntryRow | null>(null)
const finishForm = ref({ 完工日期: '', 更换部件: '', 完工结论: '' })
const detailRow = ref<EntryRow | null>(null)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const liveStats = computed(() => {
  const month = new Date().toISOString().slice(0, 7)
  return [
    { label: '待开工检修', value: rows.value.filter((row) => row.status === '待开工').length },
    { label: '检修中记录', value: rows.value.filter((row) => row.status === '检修中').length },
    {
      label: '本月完工数',
      value: rows.value.filter(
        (row) => row.status === '已完工' && String(row['完工日期'] ?? '').startsWith(month),
      ).length,
    },
    { label: '已延期记录', value: rows.value.filter((row) => row.status === '已延期').length },
  ]
})

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

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  if (action === '确认完工') {
    finishForm.value = { 完工日期: new Date().toISOString().slice(0, 10), 更换部件: '', 完工结论: '' }
    finishTarget.value = row
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function submitFinish() {
  if (!finishTarget.value) {
    return
  }
  const result = applyAction(meta.key, Number(finishTarget.value.id), '确认完工', { ...finishForm.value })
  if (!result.ok) {
    errorMessage.value = result.message
    finishTarget.value = null
    return
  }
  noticeMessage.value = result.message
  finishTarget.value = null
  reload()
}

function openDetail(row: EntryRow) {
  // 重新从同一份本地库取数，不沿用列表里的旧快照。
  detailRow.value = getEntry(meta.key, Number(row.id)) ?? null
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '设施检修管理列表读取失败'
  }
}

onMounted(reload)
</script>
