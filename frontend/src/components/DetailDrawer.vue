<template>
  <div v-if="open" class="drawer-mask" @click.self="$emit('close')">
    <aside class="drawer">
      <header class="drawer-head">
        <div>
          <h3>{{ meta.entity }}详情</h3>
          <p class="drawer-sub">与列表读取同一份数据（同源 localStorage），不存在两处口径。</p>
        </div>
        <button class="btn ghost" type="button" @click="$emit('close')">关闭</button>
      </header>
      <div v-if="row" class="drawer-body">
        <div class="detail-status">
          <span class="legend-item">当前状态：{{ row.status }}</span>
          <span class="legend-item">待办：{{ row.pending ? '是' : '否' }}</span>
          <span v-if="row.abnormal" class="legend-item warn">异常/延期</span>
        </div>
        <dl class="detail-list">
          <template v-for="field in meta.fields" :key="field">
            <dt>{{ field }}</dt>
            <dd :class="{ muted: isEmpty(row[field]) }">{{ isEmpty(row[field]) ? '—' : row[field] }}</dd>
          </template>
          <template v-for="extra in extraFields" :key="extra">
            <dt class="extra">{{ extra }}</dt>
            <dd class="extra">{{ isEmpty(row[extra]) ? '—' : row[extra] }}</dd>
          </template>
        </dl>
      </div>
      <p v-else class="drawer-empty">未找到该记录，可能已被其他入口删除或重置。</p>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import { getEntry, moduleMeta } from '@/api/local-service'

const props = defineProps<{ open: boolean; moduleKey: string; id: number | null }>()
defineEmits<{ close: [] }>()

const meta = computed(() => moduleMeta(props.moduleKey))
const row = computed(() => (props.id === null ? null : getEntry(props.moduleKey, props.id)))

const META_FIELDS = computed(() => new Set(meta.value.fields))
const extraFields = computed(() =>
  row.value ? Object.keys(row.value).filter((key) => !META_FIELDS.value.has(key) && !['id', 'status', 'pending', 'abnormal'].includes(key)) : [],
)

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}
</script>

<style scoped>
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.35);
  display: flex;
  justify-content: flex-end;
  z-index: 50;
}
.drawer {
  width: 460px;
  max-width: 92vw;
  background: #fff;
  height: 100%;
  padding: 18px 20px;
  overflow-y: auto;
  box-shadow: -8px 0 24px rgba(15, 23, 42, 0.15);
}
.drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 12px;
}
.drawer-head h3 { margin: 0; font-size: 16px; }
.drawer-sub { margin: 4px 0 0; font-size: 12px; color: var(--muted); }
.detail-status { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.legend-item { background: #eef2f7; border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.legend-item.warn { background: #fef3f2; color: #b42318; }
.detail-list { display: grid; grid-template-columns: 120px 1fr; gap: 0; margin: 0; border: 1px solid var(--border); }
.detail-list dt, .detail-list dd {
  margin: 0;
  padding: 8px 10px;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
  word-break: break-all;
}
.detail-list dt { background: #f8fafc; color: var(--muted); }
.detail-list .extra { color: #475569; }
.muted { color: #94a3b8; }
.drawer-empty { color: var(--muted); font-size: 13px; }
</style>
