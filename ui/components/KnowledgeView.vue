<script setup>
/**
 * 经验库（专家知识库）—— `experts/<id>/knowledge/*.md`
 *
 * 为什么需要这一页
 * ----------------
 * 「专家知识库 + 自动进化」是这个项目的招牌能力：每轮结束后 `reflectExperts` 用 LLM
 * 把本轮的判断提炼成可证伪的教训，追加进对应专家的 `knowledge/lessons.md`，下一轮
 * 再整体注入该专家的 systemPrompt。但在此之前，**界面上没有任何地方能看到它** ——
 * 一个每轮都在写、直接影响下一轮决策的目录，用户既看不到写了什么，也没法纠正。
 *
 * 这一页把三件事显式化（都是原先静默的）：
 *   · 每个专家 / 共享桶有哪些文件、多大、什么时候改的；
 *   · `lessons.md` 的体积占比 —— 它到上限会**裁掉最旧一半**，页面上要能提前看到；
 *   · 目录里**不会被任何专家读到**的东西（非 .md 文件、没有对应专家的遗留目录）。
 */
import { ref, computed, onActivated } from "vue";
import { api } from "../lib/api.js";
import { toastOk, toastErr, ask } from "../lib/feedback.js";

const buckets = ref([]);
const maxLessonsBytes = ref(60 * 1024);
const activeId = ref("");
const activeFile = ref("");
const draft = ref("");
const orig = ref("");
const busy = ref(false);
const saving = ref(false);
const err = ref("");
const creating = ref(null); // 新建文件时的文件名草稿（null = 未在新建）

const active = computed(() => buckets.value.find((b) => b.id === activeId.value) || null);
const files = computed(() => (active.value?.files || []).filter((f) => !f.ignored));
const ignoredFiles = computed(() => (active.value?.files || []).filter((f) => f.ignored));
const dirty = computed(() => draft.value !== orig.value);
/** 字节数（不是字符数：中文一个字 3 字节，用 length 会低估） */
const draftBytes = computed(() => new TextEncoder().encode(draft.value).length);

/** lessons.md 的体积占比（到 100% 会裁掉最旧一半） */
function lessonPct(b) {
  const f = (b.files || []).find((x) => x.auto);
  if (!f || !maxLessonsBytes.value) return null;
  return Math.min(1, f.bytes / maxLessonsBytes.value);
}
const activeLessonPct = computed(() => (active.value ? lessonPct(active.value) : null));

const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const fmtTime = (s) => (s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "—");

async function load(keepSelection = true) {
  busy.value = true;
  err.value = "";
  try {
    const r = await api.knowledgeList();
    if (!r?.ok) {
      err.value = r?.error || "读取失败（若提示缺少编译产物，请先 npm run build）";
      buckets.value = [];
      return;
    }
    buckets.value = r.buckets || [];
    if (Number.isFinite(r.maxLessonsBytes)) maxLessonsBytes.value = r.maxLessonsBytes;
    if (keepSelection && buckets.value.some((b) => b.id === activeId.value)) {
      // 保持当前选择；文件列表可能变了，旧选中项没了就退回第一个
      if (!files.value.some((f) => f.name === activeFile.value)) {
        activeFile.value = files.value[0]?.name || "";
        if (activeFile.value) await openFile(activeFile.value);
        else {
          draft.value = "";
          orig.value = "";
        }
      }
    } else {
      activeId.value = buckets.value[0]?.id || "";
      activeFile.value = "";
      draft.value = "";
      orig.value = "";
      if (files.value.length) await openFile(files.value[0].name);
    }
  } catch (e) {
    err.value = String(e?.message || e);
  } finally {
    busy.value = false;
  }
}

async function pick(b) {
  if (dirty.value && !(await ask("当前文件有未保存的修改，切换后会丢失。继续？", { title: "未保存的修改", confirmText: "丢弃" }))) {
    return;
  }
  activeId.value = b.id;
  activeFile.value = "";
  draft.value = "";
  orig.value = "";
  if (files.value.length) await openFile(files.value[0].name);
}

async function openFile(name) {
  if (dirty.value && name !== activeFile.value && !(await ask("当前文件有未保存的修改，切换后会丢失。继续？", { title: "未保存的修改", confirmText: "丢弃" }))) {
    return;
  }
  activeFile.value = name;
  draft.value = "";
  orig.value = "";
  try {
    const r = await api.knowledgeRead(activeId.value, name);
    if (!r?.ok) return void (err.value = r?.error || "读取失败");
    draft.value = r.text || "";
    orig.value = draft.value;
    err.value = "";
  } catch (e) {
    err.value = String(e?.message || e);
  }
}

async function save() {
  if (!activeId.value || !activeFile.value) return;
  saving.value = true;
  try {
    const r = await api.knowledgeWrite(activeId.value, activeFile.value, draft.value);
    if (!r?.ok) return void toastErr(new Error(r?.error || "保存失败"), "保存失败");
    orig.value = draft.value;
    toastOk(`已保存（${r.bytes} 字节）`);
    await load();
  } catch (e) {
    toastErr(e, "保存失败");
  } finally {
    saving.value = false;
  }
}

async function removeFile() {
  if (!activeId.value || !activeFile.value) return;
  if (!(await ask(`确定删除「${activeFile.value}」？此操作不可撤销。`, { title: "删除确认", confirmText: "删除", danger: true }))) return;
  try {
    const r = await api.knowledgeDelete(activeId.value, activeFile.value);
    if (!r?.ok) return void toastErr(new Error(r?.error || "删除失败"), "删除失败");
    activeFile.value = "";
    draft.value = "";
    orig.value = "";
    toastOk("已删除");
    await load();
  } catch (e) {
    toastErr(e, "删除失败");
  }
}

async function doCreate() {
  const name = String(creating.value || "").trim();
  if (!name) return;
  if (!name.toLowerCase().endsWith(".md")) return void (err.value = "文件名必须以 .md 结尾（其他后缀不会被任何专家读到）");
  if (files.value.some((f) => f.name === name)) return void (err.value = `「${name}」已存在`);
  try {
    const r = await api.knowledgeWrite(activeId.value, name, `# ${name.replace(/\.md$/i, "")}\n\n`);
    if (!r?.ok) return void (err.value = r?.error || "新建失败");
    creating.value = null;
    await load();
    await openFile(name);
    toastOk("已新建");
  } catch (e) {
    err.value = String(e?.message || e);
  }
}

onActivated(() => load());
</script>

<template>
  <div class="panel">
    <h2>专家经验库
      <span class="spacer"></span>
      <button class="sm" :disabled="busy" @click="load()">{{ busy ? "读取中…" : "刷新" }}</button>
    </h2>
    <div class="body">
      <div v-if="err" class="alert err" style="margin-bottom:10px">{{ err }}</div>

      <div class="kb">
        <!-- 左：经验库（每个专家一个 + 共享桶 + 遗留目录） -->
        <div class="kb-side">
          <div v-for="b in buckets" :key="b.id"
               :class="['kb-item', activeId === b.id && 'on']"
               @click="pick(b)">
            <div class="kb-name">
              <b>{{ b.name }}</b>
              <span v-if="b.shared" class="tag t-info">共享</span>
              <span v-else-if="b.orphan" class="tag t-sell">无专家</span>
              <span v-else-if="b.enabled === false" class="tag t-off">停用</span>
            </div>
            <div class="kb-meta">
              <code class="hint">{{ b.id }}</code>
              <span class="hint">{{ (b.files || []).length }} 个文件</span>
            </div>
            <div v-if="lessonPct(b) != null" class="kb-bar">
              <i :class="['fill', lessonPct(b) > 0.75 ? 'warn' : '']" :style="{ width: (lessonPct(b) * 100).toFixed(1) + '%' }"></i>
            </div>
          </div>
          <div v-if="!buckets.length && !busy" class="empty">暂无经验库</div>
        </div>

        <!-- 右：文件列表 + 编辑 -->
        <div class="kb-main">
          <template v-if="active">
            <div class="kb-head">
              <b>{{ active.name }}</b>
              <span v-if="active.shared" class="hint">这个桶里的内容会注入给 <b>每一个</b> 专家</span>
              <span v-else-if="active.orphan" class="hint">没有 id 为 <code>{{ active.id }}</code> 的专家 —— 这里的文件不会被任何专家读到</span>
              <span class="spacer"></span>
              <button class="sm" @click="creating = ''">+ 新建 .md</button>
            </div>

            <div v-if="ignoredFiles.length" class="alert" style="margin:8px 0">
              ⚠ 目录里有 {{ ignoredFiles.length }} 个文件 <b>不会被任何专家读到</b>（不是 .md 或文件名非法）：
              {{ ignoredFiles.map((f) => f.name).join("、") }}
            </div>

            <div v-if="activeFile && activeFile === 'lessons.md'" class="hint" style="margin:8px 0">
              这是自动进化沉淀的文件：每轮由复盘追加。
              <b v-if="activeLessonPct != null">当前 {{ fmtBytes(files.find((f) => f.auto)?.bytes || 0) }} / {{ fmtBytes(maxLessonsBytes) }}（{{ (activeLessonPct * 100).toFixed(1) }}%）</b>
              —— 到上限会 <b>裁掉最旧一半</b> 并在文件顶部留一条记录。想保住重要教训，把它挪进自己新建的 .md。
            </div>

            <div v-if="creating !== null" class="docs-dlg">
              <input v-model="creating" placeholder="文件名，如 02-仓位经验.md" @keyup.enter="doCreate" />
              <button class="primary sm" @click="doCreate">创建</button>
              <button class="sm" @click="creating = null">取消</button>
            </div>

            <div class="kf-list">
              <span v-for="f in files" :key="f.name"
                    :class="['kf', activeFile === f.name && 'on']"
                    :title="`${fmtBytes(f.bytes)} · ${fmtTime(f.mtime)}`"
                    @click="openFile(f.name)">
                {{ f.name }}
                <i v-if="f.auto" class="auto">自动</i>
              </span>
              <span v-if="!files.length" class="hint">这个经验库还没有 .md 文件</span>
            </div>

            <template v-if="activeFile">
              <div class="kb-sub">
                <span class="hint">
                  {{ activeFile }} · {{ fmtBytes(draftBytes) }}
                  <template v-if="dirty"> · <b>未保存</b></template>
                </span>
                <span class="spacer"></span>
                <div class="btn-group">
                  <button class="sm primary" :disabled="saving || !dirty" @click="save">{{ saving ? "保存中…" : "保存" }}</button>
                  <button class="sm" :disabled="!dirty" @click="draft = orig">还原</button>
                  <button class="sm danger" @click="removeFile">删除</button>
                </div>
              </div>
              <textarea v-model="draft" spellcheck="false" class="kb-editor"></textarea>
              <div class="hint" style="margin-top:6px">
                保存后 <b>下一轮</b> 或 <b>下一次对话</b> 才生效（知识库在组装 system prompt 时读取）。
              </div>
            </template>
            <div v-else class="empty">选一个文件开始编辑</div>
          </template>
          <div v-else class="empty">左侧选一个经验库</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.kb { display: grid; grid-template-columns: 246px minmax(0, 1fr); gap: 12px; align-items: start; }
.kb-side { display: flex; flex-direction: column; gap: 4px; max-height: 66vh; overflow: auto; }
.kb-item {
  padding: 7px 9px; border-radius: var(--r-sm); cursor: pointer;
  border: 1px solid transparent;
}
.kb-item:hover { background: var(--surface-2); }
.kb-item.on { background: var(--surface-3); border-color: var(--border-strong); }
.kb-name { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
.kb-meta { display: flex; gap: 8px; font-size: 11px; margin-top: 2px; }
.kb-bar { height: 3px; border-radius: 2px; background: var(--border); overflow: hidden; margin-top: 5px; }
.kb-bar .fill { display: block; height: 100%; background: var(--blue); transition: width var(--ease); }
.kb-bar .fill.warn { background: var(--yellow); }
.kb-main { min-width: 0; }
.kb-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kf-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 9px 0; }
.kf {
  font-size: 12px; padding: 3px 8px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2);
}
.kf:hover { border-color: var(--border-strong); }
.kf.on { background: rgba(47, 111, 237, .12); border-color: var(--blue); color: var(--text); }
.kf .auto { font-size: 10px; color: var(--dim); margin-left: 4px; font-style: normal; }
.kb-sub { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.kb-editor {
  width: 100%; height: 44vh; min-height: 240px; resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.65;
  padding: 10px 12px; border-radius: var(--r-sm);
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
}
.docs-dlg { display: flex; gap: 6px; align-items: center; margin: 8px 0; }
.docs-dlg input { flex: 1; max-width: 340px; }
</style>
