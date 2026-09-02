<script setup>
/**
 * 日志：agent 服务实时输出
 *
 * 「自动滚动」默认开；用户手动往上翻历史时会关掉，
 * 否则新日志不断涌进来会把视线强行拽回底部。
 */
import { ref, computed, watch, nextTick, onMounted } from "vue";
import { logs } from "../store/index.js";
import { toastOk, toastErr } from "../lib/feedback.js";

const box = ref(null);
const auto = ref(true);
const shown = computed(() => logs.value.join("\n"));

function scrollToEnd() {
  if (!auto.value) return;
  nextTick(() => {
    const el = box.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(() => logs.value.length, scrollToEnd);
watch(auto, scrollToEnd);
onMounted(scrollToEnd);

function clear() {
  logs.value = [];
}

async function copy() {
  try {
    await navigator.clipboard.writeText(shown.value);
    toastOk("日志已复制到剪贴板");
  } catch (e) {
    toastErr(e, "复制失败");
  }
}
</script>

<template>
  <div class="panel log-page">
    <h2>运行日志<span class="spacer"></span>
      <div class="panel-actions">
        <span class="hint">{{ logs.length }} 行</span>
        <button class="sm" :class="auto && 'primary'" @click="auto = !auto">
          自动滚动 {{ auto ? "开" : "关" }}
        </button>
        <button class="sm" :disabled="!logs.length" @click="copy">复制</button>
        <button class="sm danger" :disabled="!logs.length" @click="clear">清空</button>
      </div>
    </h2>
    <div class="body">
      <div id="log" ref="box">{{ shown }}</div>
    </div>
    <div class="body hint" style="padding-top:0">
      仅界面显示，不影响 agent/data 下的日志文件；清空只清当前窗口的缓冲。
    </div>
  </div>
</template>
