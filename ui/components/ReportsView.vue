<script setup>
/**
 * ReportsView —— 报告中心：查看「全部」报告，而不是只有一次生成的日报/周报。
 *
 * 三类报告：
 *   - 轮次报告（HTML）：每轮决策一份，reports/<round_id>/summary.html + <角色>.html，
 *     由 src/report.ts 落盘（LLM 出 HTML，失败回退纯数据页），界面用 iframe 原样渲染。
 *   - 日报 / 周报（Markdown）：scripts/report.py 从台账确定性统计，文本预览。
 */
import { ref, computed, onMounted } from "vue";
import { api } from "../lib/api.js";
import { openDocWin } from "../lib/nav.js";
import { toast, toastErr } from "../lib/feedback.js";

const DT = { OPEN: "开仓", HOLD: "持有", CLOSE: "平仓", STANDBY: "观望" };
const RT = { BASE: "基准", AGG: "进攻", DEF: "防守" };

const mode = ref("rounds"); // rounds | daily | weekly
const rounds = ref([]); // 轮次报告（每轮含多份 HTML）
const indexPath = ref(""); // reports/index.html
const mdFiles = ref({ daily: [], weekly: [] });

const curRound = ref(null);
const curDoc = ref(null); // { path, label }
const docHtml = ref("");
const mdText = ref("");
const busy = ref(false);
const loading = ref(false);

const list = computed(() => (mode.value === "rounds" ? rounds.value : mdFiles.value[mode.value] || []));
const docs = computed(() => curRound.value?.docs ?? []);

function fmtSize(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}
function fmtTime(v) {
  if (!v) return "—";
  try {
    const d = new Date(v);
    if (Number.isNaN(+d)) return String(v);
    const p = (x) => String(x).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return String(v);
  }
}
function fmtMoney(v) {
  return v == null ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function refresh() {
  if (busy.value) return;
  busy.value = true;
  try {
    const r = await api.reportsRounds();
    if (r?.ok) {
      rounds.value = r.rounds || [];
      indexPath.value = r.indexPath || "";
      if (r.added > 0) toast(`已补齐 ${r.added} 轮历史报告`, "ok");
    } else if (r?.error) {
      toast(r.error, "err");
    }
    const md = await api.reportsList();
    mdFiles.value = { daily: md?.daily || [], weekly: md?.weekly || [] };
    // 列表刷新后：当前轮次还在就保持选中并刷新文档，否则回到最新一轮
    if (mode.value === "rounds" && rounds.value.length) {
      const still = rounds.value.find((x) => x.round_id === curRound.value?.round_id);
      selectRound(still || rounds.value[0]);
    }
  } catch (e) {
    toastErr(e, "读取报告列表失败");
  } finally {
    busy.value = false;
  }
}

async function loadHtml(path, label, key) {
  curDoc.value = { path, label, key };
  docHtml.value = "";
  mdText.value = "";
  if (!path) return;
  loading.value = true;
  try {
    const r = await api.reportsHtml(path);
    if (!r?.ok) {
      toast(r?.error || "读取报告失败", "err");
      return;
    }
    docHtml.value = r.html || "";
  } catch (e) {
    toastErr(e, "读取报告失败");
  } finally {
    loading.value = false;
  }
}

function selectRound(r) {
  curRound.value = r || null;
  mdText.value = "";
  if (!r?.docs?.length) {
    curDoc.value = null;
    docHtml.value = "";
    return;
  }
  const first = r.docs.find((d) => d.key === "summary") || r.docs[0];
  loadHtml(first.path, first.label, first.key);
}

/** 重新加载当前文档（外部改动过、或想刷新 iframe 时） */
function reload() {
  const d = curDoc.value;
  if (!d?.path) return;
  if (d.key === "md") selectMd({ path: d.path, name: d.label });
  else loadHtml(d.path, d.label, d.key);
}

async function selectMd(f) {
  curRound.value = null;
  curDoc.value = { path: f.path, label: f.name, key: "md" };
  docHtml.value = "";
  mdText.value = "";
  loading.value = true;
  try {
    const r = await api.reportsRead(f.path);
    mdText.value = r?.ok ? r.text || "" : "";
    if (!r?.ok) toast(r?.error || "读取失败", "err");
  } catch (e) {
    toastErr(e, "读取报告失败");
  } finally {
    loading.value = false;
  }
}

async function openIndex() {
  if (!indexPath.value) return;
  curRound.value = null;
  await loadHtml(indexPath.value, "轮次记录表", "index");
}

/** 用 LLM 重新生成本轮报告（历史补生成的默认是纯数据页，可一键换成 LLM 版） */
async function regen() {
  const id = curRound.value?.round_id;
  if (!id || busy.value) return;
  busy.value = true;
  try {
    const r = await api.reportsRegen(id);
    if (!r?.ok) {
      toast(r?.error || "重新生成失败", "err");
      return;
    }
    rounds.value = r.rounds || rounds.value;
    toast(`${id} 报告已重新生成`, "ok");
    const again = rounds.value.find((x) => x.round_id === id);
    if (again) selectRound(again);
  } catch (e) {
    toastErr(e, "重新生成失败");
  } finally {
    busy.value = false;
  }
}

/** 在独立窗口里看（右侧预览区太窄，长报告读着费劲） */
async function openInWindow() {
  if (!curDoc.value?.path) return;
  const r = await openDocWin(curDoc.value.path, curDoc.value.label);
  if (r && r.ok === false) toast(r.error || "打开窗口失败", "err");
}

async function openExternal() {
  if (!curDoc.value?.path) return;
  try {
    const r = await api.reportsOpen(curDoc.value.path);
    if (!r?.ok) toast(r?.error || "打开失败", "err");
  } catch (e) {
    toastErr(e, "打开报告失败");
  }
}

async function openDir() {
  try {
    await api.reportsDir();
  } catch (e) {
    toastErr(e, "打开目录失败");
  }
}

async function gen(kind) {
  if (busy.value) return;
  busy.value = true;
  try {
    const r = await api.reportsGen(kind);
    if (!r?.ok) {
      toast(r?.error || "生成失败", "err");
      return;
    }
    toast(kind === "weekly" ? "周报已生成" : "日报已生成", "ok");
    mdFiles.value = { daily: r.reports?.daily || [], weekly: r.reports?.weekly || [] };
    mode.value = kind;
  } catch (e) {
    toastErr(e, "生成报告失败");
  } finally {
    busy.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <div class="rep-page">
    <div class="head-row rep-head">
      <div class="btn-group">
        <button :class="mode === 'rounds' && 'primary'" @click="mode = 'rounds'">轮次报告（HTML）</button>
        <button :class="mode === 'daily' && 'primary'" @click="mode = 'daily'">日报</button>
        <button :class="mode === 'weekly' && 'primary'" @click="mode = 'weekly'">周报</button>
      </div>
      <span class="spacer"></span>
      <div class="btn-group">
        <span v-if="mode === 'rounds'" class="hint">每轮一份 HTML（汇总 + 各角色），点左侧轮次查看</span>
        <button v-if="mode === 'rounds'" @click="openIndex">轮次记录表</button>
        <button v-if="mode !== 'rounds'" :disabled="busy" @click="gen(mode)">
          {{ busy ? "生成中…" : `生成今日${mode === "weekly" ? "周报" : "日报"}` }}
        </button>
        <button :disabled="busy" @click="refresh">{{ busy ? "刷新中…" : "刷新" }}</button>
        <button @click="openDir">打开报告目录</button>
      </div>
    </div>

    <div class="rep-main">
      <!-- 左：报告列表（全部历史，新的在前） -->
      <div class="panel list-panel">
        <h2>
          {{ mode === "rounds" ? "轮次报告" : mode === "weekly" ? "周报" : "日报" }}
          <span class="spacer"></span>
          <span class="hint">{{ list.length }} 份</span>
        </h2>
        <div class="body list-body">
          <table v-if="mode === 'rounds' && rounds.length">
            <thead>
              <tr><th>轮次</th><th>时间</th><th>决策</th><th>权益</th></tr>
            </thead>
            <tbody>
              <tr
                v-for="r in rounds"
                :key="r.round_id"
                :class="curRound?.round_id === r.round_id && 'cur'"
                @click="selectRound(r)"
              >
                <td class="mono">{{ r.round_id }}</td>
                <td class="nowrap dim">{{ fmtTime(r.time_cst) }}</td>
                <td class="nowrap">
                  <span v-if="r.decision_type" class="t">{{ DT[r.decision_type] || r.decision_type }}</span>
                  <span v-if="r.risk_tier" :class="['t', r.risk_tier === 'DEF' ? 'def' : r.risk_tier === 'AGG' ? 'agg' : '']">
                    {{ RT[r.risk_tier] || r.risk_tier }}
                  </span>
                  <span v-if="!r.decision_type && !r.risk_tier" class="dim">—</span>
                </td>
                <td class="nowrap num">{{ fmtMoney(r.equity_usdt) }}</td>
              </tr>
            </tbody>
          </table>

          <table v-else-if="mode !== 'rounds' && list.length">
            <thead><tr><th>文件</th><th>大小</th><th>时间</th></tr></thead>
            <tbody>
              <tr
                v-for="f in list"
                :key="f.path"
                :class="curDoc?.path === f.path && 'cur'"
                @click="selectMd(f)"
              >
                <td class="mono">{{ f.name }}</td>
                <td class="nowrap dim">{{ fmtSize(f.size) }}</td>
                <td class="nowrap dim">{{ fmtTime(f.mtime) }}</td>
              </tr>
            </tbody>
          </table>

          <div v-else class="empty">
            <template v-if="mode === 'rounds'">暂无轮次报告，跑一轮决策后自动生成</template>
            <template v-else>暂无{{ mode === "weekly" ? "周报" : "日报" }}，点上方「生成」创建</template>
          </div>
        </div>
      </div>

      <!-- 右：预览（HTML 用 iframe 原样渲染；Markdown 用文本） -->
      <div class="panel view-panel">
        <h2>
          预览：{{ curDoc?.label || "未选择" }}
          <span class="spacer"></span>
          <span v-if="curRound" class="hint">
            {{ curRound.round_id }} · {{ fmtTime(curRound.time_cst) }} · {{ curRound.env }}
          </span>
          <div class="panel-actions">
            <button v-if="curRound" class="sm" :disabled="busy" @click="regen">
              {{ busy ? "生成中…" : "用 LLM 重新生成" }}
            </button>
            <button class="sm" :disabled="!curDoc?.path" @click="reload">重新加载</button>
            <button class="sm" :disabled="!curDoc?.path" @click="openInWindow">⧉ 独立窗口</button>
            <button class="sm" :disabled="!curDoc?.path" @click="openExternal">外部打开</button>
          </div>
        </h2>

        <!-- 文档切换：汇总 + 各角色页 -->
        <div v-if="docs.length > 1" class="doc-tabs">
          <button
            v-for="d in docs"
            :key="d.path"
            :class="['doc-tab', curDoc?.path === d.path && 'on']"
            @click="loadHtml(d.path, d.label, d.key)"
          >
            {{ d.label }}
          </button>
        </div>

        <div class="body view-body">
          <iframe v-if="docHtml" :srcdoc="docHtml" title="报告预览"></iframe>
          <pre v-else-if="mdText" class="md-pre">{{ mdText }}</pre>
          <div v-else class="empty">
            {{ loading ? "加载中…" : "从左侧选择一份报告查看" }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rep-main {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 340px 1fr;
  gap: 12px;
}
.rep-main .panel {
  margin-bottom: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.list-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0;
}
.list-body table td {
  cursor: pointer;
}
.mono { font-family: Consolas, "Cascadia Code", monospace; white-space: nowrap }
.dim { color: var(--dim) }
.num { font-variant-numeric: tabular-nums; text-align: right }
.nowrap { white-space: nowrap }
tr.cur { background: var(--hover) }
.t {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--surface-3);
  color: var(--dim);
  margin-right: 4px;
}
.t.agg { background: color-mix(in srgb, var(--yellow) 18%, transparent); color: var(--yellow) }
.t.def { background: color-mix(in srgb, var(--red) 18%, transparent); color: var(--red) }

.doc-tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.doc-tab {
  padding: 3px 12px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
}
.doc-tab:hover { background: var(--hover) }
.doc-tab.on {
  border-color: var(--blue);
  color: var(--blue);
  background: color-mix(in srgb, var(--blue) 10%, transparent);
}

.panel .body.view-body {
  flex: 1;
  min-height: 0;
  padding: 0;
  display: flex;
}
.rep-page iframe {
  flex: 1;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
.md-pre {
  flex: 1;
  margin: 0;
  padding: 14px 16px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  background: var(--code-bg);
  color: var(--code-text);
}
.empty {
  padding: 24px;
  color: var(--dim);
  text-align: center;
  font-size: 12.5px;
}
</style>
