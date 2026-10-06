<template>
  <section class="page" data-module="maintenance">
    <header class="page-head">
      <div>
        <h2>设施检修管理</h2>
        <p class="page-desc">提交开工 → 确认完工 / 申请延期按顺序推进，跳档一律打回；完工一次落状态、完工日期与更换部件，并同步设备保养台账。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出设施检修清单</button>
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
            <button v-if="column === '检修编号'" class="link" type="button" @click="openDetail(row.id)">
              {{ row[column] }}
            </button>
            <span v-else :class="{ muted: isEmpty(row[column]) }">{{ isEmpty(row[column]) ? '—' : row[column] }}</span>
          </td>
          <td>
            <span :class="['status-tag', statusClass(row.status)]">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="!canRun(action, row.status)"
              :title="actionHint(action, row.status)"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无设施检修数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条检修记录 · 点击检修编号查看同源详情</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
    </footer>

    <!-- 完工表单：状态、完工日期、更换部件、完工结论一次提交，一次落库 -->
    <div v-if="completeTarget" class="drawer-mask" @click.self="closeComplete">
      <form class="modal" @submit.prevent="submitComplete">
        <h3>确认完工 · {{ completeTarget['检修编号'] }}</h3>
        <p class="drawer-sub">检修对象：{{ completeTarget['检修对象'] }}（{{ completeTarget['检修类别'] }}）</p>
        <label class="form-item">
          <span>完工日期 <i>*</i></span>
          <input v-model="completeForm['完工日期']" type="date" />
        </label>
        <label class="form-item">
          <span>更换部件 <i>*</i></span>
          <input v-model="completeForm['更换部件']" placeholder="如：机械密封1套；未更换请填「无」" />
        </label>
        <label class="form-item">
          <span>完工结论 <i>*</i></span>
          <textarea v-model="completeForm['完工结论']" rows="3" placeholder="将写入设备台账保养计划，并生成待保养条目"></textarea>
        </label>
        <p v-if="completeError" class="error-text">{{ completeError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeComplete">取消</button>
          <button class="btn primary" type="submit">确认完工落库</button>
        </div>
      </form>
    </div>

    <DetailDrawer :open="detailId !== null" :module-key="meta.key" :id="detailId" @close="detailId = null" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import DetailDrawer from '@/components/DetailDrawer.vue'
import type { EntryRow, MaintenanceCompleteInput } from '@/data/types'
import { today } from '@/data/maintenance'

const meta = moduleMeta('maintenance')
const columns = ['检修编号', '检修对象', '检修类别', '检修班组', '计划工期', '完工日期', '更换部件', '完工结论']
const actions = ['提交开工', '确认完工', '申请延期']

// 顺序链路段位：待开工(1) → 检修中(2) ⇄ 已延期(3) → 已完工(4，终态)
const ENABLED: Record<string, string[]> = {
  提交开工: ['待开工'],
  申请延期: ['检修中'],
  确认完工: ['检修中', '已延期'],
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['检修编号', '检修对象', '检修班组']
const detailId = ref<number | null>(null)

const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待开工检修', value: rows.value.filter((r) => r.status === '待开工').length },
  { label: '检修中（含延期）', value: rows.value.filter((r) => r.status === '检修中' || r.status === '已延期').length },
  { label: '本月完工数', value: rows.value.filter((r) => r.status === '已完工' && String(r['完工日期']).startsWith(today().slice(0, 7))).length },
  { label: '待复役（已完工未保养设备）', value: pendingDeviceCount() },
])

function pendingDeviceCount(): number {
  // 设备台账中由检修完工派生、仍待保养的条目：机组等这些保养闭环才允许复役。
  return listEntries('device').items.filter(
    (r) => String(r['来源检修单'] ?? '') !== '' && r.status === '待保养',
  ).length
}

function canRun(action: string, status: string): boolean {
  return ENABLED[action].includes(status)
}

function actionHint(action: string, status: string): string {
  if (canRun(action, status)) {
    return `执行「${action}」`
  }
  return `当前「${status}」不满足「${action}」的前置段位，跳档会被打回`
}

function statusClass(status: string): string {
  if (status === '已完工') return 'ok'
  if (status === '已延期') return 'warn'
  return ''
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openDetail(id: number) {
  detailId.value = id
}

// ---- 确认完工 ----
const completeTarget = ref<EntryRow | null>(null)
const completeError = ref('')
const completeForm = reactive<MaintenanceCompleteInput>({
  完工日期: today(),
  更换部件: '',
  完工结论: '',
})

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '确认完工') {
    if (!canRun(action, String(row.status))) {
      errorMessage.value = actionHint(action, String(row.status))
      return
    }
    completeTarget.value = row
    completeError.value = ''
    completeForm['完工日期'] = today()
    completeForm['更换部件'] = ''
    completeForm['完工结论'] = ''
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  noticeMessage.value = result.message
}

function closeComplete() {
  completeTarget.value = null
}

function submitComplete() {
  if (!completeTarget.value) return
  const result = applyAction(meta.key, Number(completeTarget.value.id), '确认完工', { ...completeForm })
  if (!result.ok) {
    completeError.value = result.message
    return
  }
  completeTarget.value = null
  reload()
  noticeMessage.value = result.message
}

function reload() {
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '设施检修列表读取失败'
  }
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
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}
.modal {
  width: 480px;
  max-width: 92vw;
  background: #fff;
  border-radius: 10px;
  padding: 20px 22px;
}
.modal h3 { margin: 0 0 4px; font-size: 16px; }
.drawer-sub { font-size: 12px; color: var(--muted); margin: 0 0 12px; }
.form-item { display: block; margin-bottom: 12px; }
.form-item span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.form-item i { color: #b42318; font-style: normal; }
.form-item input, .form-item textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 10px;
  font: inherit;
}
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
