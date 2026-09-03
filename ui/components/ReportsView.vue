<script setup>
/**
 * ReportsView —— 报告入口：日报/周报列表、应用内预览、生成与外部打开。
 * 报告由 scripts/report.py 从 ledger/trades.csv + logs/rounds.jsonl 确定性统计生成。
 */
import { ref, onMounted } from "vue";
import { api } from "../lib/api.js";
import { toast, toastErr } from "../lib/feedback.js";

const daily = ref([]);
const weekly = ref([]);
const preview = ref(null); // { name, text }
const genBusy = ref("");

function fmtSize(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}
function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

async function refresh() {
  try {
    const r = await api.reportsList();
    daily.value = r?.daily || [];
    weekly.value = r?.weekly || [];
  } catch (e) {
    toastErr(e, "读取报告列表失败");
  }
}

async function previewReport(f) {
  try {
    const r = await api.reportsRead(f.path);
    if (!r?.ok) {
      toast(r?.error || "读取失败", "err");
      return;
    }
    preview.value = { name: f.name, text: r.text };
  } catch (e) {
    toastErr(e, "读取报告失败");
  }
}

async function openExternal(f) {
  try {
    const r = await api.reportsOpen(f.path);
    if (!r?.ok) toast(r?.error || "打开失败", "err");
  } catch (e) {
    toastErr(e, "打开报告失败");
  }
}

async function gen(kind) {
  if (genBusy.value) return;
  genBusy.value = kind;
  try {
    const r = await api.reportsGen(kind);
    if (!r?.ok) {
      toast(r?.error || "生成失败", "err");
      return;
    }
    toast(kind === "weekly" ? "周报已生成" : "日报已生成", "ok");
    daily.value = r.reports?.daily || [];
    weekly.value = r.reports?.weekly || [];
  } catch (e) {
    toastErr(e, "生成报告失败");
  } finally {
    genBusy.value = "";
  }
}

async function openDir() {
  try {
    await api.reportsDir();
  } catch (e) {
    toastErr(e, "打开目录失败");
  }
}

onMounted(refresh);
</script>

<template>
  <div class="head-row">
    <div class="btn-group">
      <button class="primary" :disabled="!!genBusy" @click="gen('daily')">
        {{ genBusy === 'daily' ? '生成中…' : '生成今日日报' }}
      </button>
      <button :disabled="!!genBusy" @click="gen('weekly')">
        {{ genBusy === 'weekly' ? '生成中…' : '生成本周周报' }}
      </button>
      <button @click="openDir">打开报告目录</button>
      <button @click="refresh">刷新</button>
    </div>
    <span class="spacer"></span>
    <span class="hint">报告由 scripts/report.py 从台账与轮次归档确定性统计生成</span>
  </div>

  <div class="rep-grid">
    <div class="panel">
      <h2>日报（{{ daily.length }}）</h2>
      <div class="body">
        <table v-if="daily.length">
          <thead><tr><th>文件</th><th>大小</th><th>时间</th><th></th></tr></thead>
          <tbody>
            <tr v-for="f in daily" :key="f.path" :class="preview?.name === f.name && 'cur'">
              <td><a class="rep-link" @click="previewReport(f)">{{ f.name }}</a></td>
              <td class="nowrap">{{ fmtSize(f.size) }}</td>
              <td class="nowrap">{{ fmtTime(f.mtime) }}</td>
              <td class="nowrap"><button class="sm" @click="openExternal(f)">外部打开</button></td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">暂无日报，点「生成今日日报」创建</div>
      </div>
    </div>

    <div class="panel">
      <h2>周报（{{ weekly.length }}）</h2>
      <div class="body">
        <table v-if="weekly.length">
          <thead><tr><th>文件</th><th>大小</th><th>时间</th><th></th></tr></thead>
          <tbody>
            <tr v-for="f in weekly" :key="f.path" :class="preview?.name === f.name && 'cur'">
              <td><a class="rep-link" @click="previewReport(f)">{{ f.name }}</a></td>
              <td class="nowrap">{{ fmtSize(f.size) }}</td>
              <td class="nowrap">{{ fmtTime(f.mtime) }}</td>
              <td class="nowrap"><button class="sm" @click="openExternal(f)">外部打开</button></td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">暂无周报，点「生成本周周报」创建</div>
      </div>
    </div>
  </div>

  <div v-if="preview" class="panel" style="margin-top:12px">
    <h2>
      预览：{{ preview.name }}
      <button class="sm" style="float:right" @click="preview = null">关闭预览</button>
    </h2>
    <div class="body rep-pre">{{ preview.text }}</div>
  </div>
</template>

<style scoped>
.rep-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.rep-link { cursor: pointer; color: var(--c-primary, #2563eb); }
.rep-link:hover { text-decoration: underline; }
tr.cur { background: color-mix(in srgb, var(--c-primary, #2563eb) 8%, transparent); }
.rep-pre { white-space: pre-wrap; font-size: 12px; line-height: 1.7; max-height: 60vh; overflow: auto; }
</style>
