/** 共用工具与弹窗组件 */

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
export function fmtNum(n, d = 2) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function signCls(n) {
  return n > 0 ? "up" : n < 0 ? "down" : "";
}
export function uid(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 9);
}
export const STANCE_TEXT = { bullish: "看多", bearish: "看空", neutral: "中性", abstain: "弃权" };

/** 通用编辑弹窗：title + 表单字段定义 + 保存回调 */
export const Modal = {
  props: ["title", "fields", "modelValue", "onSave"],
  emits: ["close"],
  setup(props, { emit }) {
    const form = JSON.parse(JSON.stringify(props.modelValue || {}));
    const val = (k) => form[k];
    const set = (k, v) => { form[k] = v; };
    async function save() {
      await props.onSave(form);
      emit("close");
    }
    return { form, val, set, save, emit };
  },
  template: `
  <div class="modal show" @click.self="$emit('close')">
    <div class="box">
      <h3>{{ title }}</h3>
      <div class="body">
        <div class="row" v-for="f in fields" :key="f.k">
          <label>{{ f.label }}</label>
          <textarea v-if="f.type==='textarea'" v-model="form[f.k]" :placeholder="f.ph"></textarea>
          <select v-else-if="f.type==='select'" v-model="form[f.k]">
            <option v-for="o in f.options" :key="o.v" :value="o.v">{{ o.t }}</option>
          </select>
          <input v-else-if="f.type==='checkbox'" type="checkbox" v-model="form[f.k]" />
          <input v-else :type="f.type||'text'" v-model="form[f.k]" :placeholder="f.ph" />
        </div>
      </div>
      <div class="foot">
        <button @click="$emit('close')">取消</button>
        <button class="primary" @click="save">保存</button>
      </div>
    </div>
  </div>`,
};
