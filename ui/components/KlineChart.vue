<script setup>
/**
 * KlineChart —— 自绘 SVG 蜡烛图（项目无图表库，不引第三方依赖）
 * 输入：candles = [{t,o,h,l,c,v}]，必须按时间正序（旧→新）
 * 渲染：蜡烛 + 成交量 + MA5/MA10 + 最新价虚线 + 悬停十字光标读数
 */
import { computed, ref } from "vue";

const props = defineProps({
  candles: { type: Array, default: () => [] },
});

const W = 900;
const H = 380;
const PAD_L = 8;
const PAD_R = 62; // 右侧价格轴
const PAD_T = 12;
const VOL_H = 56;
const GAP = 10;
const CHART_H = H - PAD_T - VOL_H - GAP - 20;

const hoverIdx = ref(-1);

/** 价格自适应小数位：BTC 给 2 位，SHIB 这类极小数给足有效位 */
function fmtPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtVol(v) {
  const n = Number(v) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(2);
}
function fmtTime(t, dayBar) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return dayBar
    ? `${p(d.getMonth() + 1)}-${p(d.getDate())}`
    : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const geom = computed(() => {
  const cs = props.candles || [];
  if (cs.length < 2) return null;

  let lo = Infinity;
  let hi = -Infinity;
  let maxV = 0;
  for (const k of cs) {
    lo = Math.min(lo, k.l);
    hi = Math.max(hi, k.h);
    maxV = Math.max(maxV, k.v);
  }
  const span = hi - lo || Math.abs(hi) * 0.001 || 1;
  lo -= span * 0.06;
  hi += span * 0.06;
  maxV = maxV || 1;

  const n = cs.length;
  const plotW = W - PAD_L - PAD_R;
  const step = plotW / n;
  const bw = Math.max(1, Math.min(11, step * 0.68));
  const y = (p) => PAD_T + ((hi - p) / (hi - lo)) * CHART_H;
  const x = (i) => PAD_L + step * (i + 0.5);
  const volBase = PAD_T + CHART_H + GAP + VOL_H;

  const items = cs.map((k, i) => {
    const up = k.c >= k.o;
    return {
      k,
      i,
      cx: x(i),
      bw,
      yHigh: y(k.h),
      yLow: y(k.l),
      up,
      bodyTop: y(Math.max(k.o, k.c)),
      bodyH: Math.max(1, Math.abs(y(k.o) - y(k.c))),
      volTop: volBase - (k.v / maxV) * VOL_H,
      volH: Math.max(1, (k.v / maxV) * VOL_H),
    };
  });

  const maPoints = (p) =>
    items
      .map((it, i) => {
        if (i < p - 1) return null;
        let s = 0;
        for (let j = i - p + 1; j <= i; j++) s += cs[j].c;
        return `${it.cx.toFixed(1)},${y(s / p).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");

  // 价格轴刻度
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => ({
    y: PAD_T + r * CHART_H,
    v: hi - r * (hi - lo),
  }));

  // 时间轴：均匀取 6 个
  const stepIdx = Math.max(1, Math.floor(n / 6));
  const xLabels = items
    .filter((it, i) => i % stepIdx === 0 || i === n - 1)
    .map((it) => ({ x: it.cx, t: it.k.t }));

  const last = cs[cs.length - 1];
  return {
    items,
    ticks,
    xLabels,
    ma5: maPoints(5),
    ma10: maPoints(10),
    lastPrice: last.c,
    lastY: y(last.c),
    up: last.c >= cs[cs.length - 2].c,
    volBase,
  };
});

const hoverItem = computed(() => {
  const g = geom.value;
  if (!g || hoverIdx.value < 0) return null;
  return g.items[hoverIdx.value] || null;
});

function onMove(e) {
  const g = geom.value;
  if (!g) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const rel = ((e.clientX - rect.left) / rect.width) * W; // SVG 坐标
  const n = g.items.length;
  const plotW = W - PAD_L - PAD_R;
  const idx = Math.floor(((rel - PAD_L) / plotW) * n);
  hoverIdx.value = idx >= 0 && idx < n ? idx : -1;
}
</script>

<template>
  <div v-if="geom" class="kl">
    <div class="kl-head">
      <span v-if="hoverItem" class="kl-oh">
        <b>{{ fmtTime(hoverItem.k.t, false) }}</b>
        开 {{ fmtPrice(hoverItem.k.o) }}
        高 <span class="up">{{ fmtPrice(hoverItem.k.h) }}</span>
        低 <span class="down">{{ fmtPrice(hoverItem.k.l) }}</span>
        收 <b>{{ fmtPrice(hoverItem.k.c) }}</b>
        量 {{ fmtVol(hoverItem.k.v) }}
      </span>
      <span v-else class="kl-oh hint">鼠标移到图上查看单根 K 线明细 · MA5 蓝 / MA10 橙</span>
    </div>

    <svg :viewBox="`0 0 ${W} ${H}`" class="kl-svg" @mousemove="onMove" @mouseleave="hoverIdx = -1">
      <!-- 网格 -->
      <g class="kl-grid">
        <line v-for="t in geom.ticks" :key="t.y" x1="0" :x2="W - PAD_R" :y1="t.y" :y2="t.y" />
      </g>
      <text
        v-for="t in geom.ticks"
        :key="'l' + t.y"
        :x="W - PAD_R + 6"
        :y="t.y + 4"
        class="kl-axis"
      >
        {{ fmtPrice(t.v) }}
      </text>
      <text
        v-for="l in geom.xLabels"
        :key="'x' + l.t"
        :x="l.x"
        :y="H - 4"
        class="kl-axis"
        text-anchor="middle"
      >
        {{ fmtTime(l.t, false) }}
      </text>

      <!-- 成交量 -->
      <rect
        v-for="it in geom.items"
        :key="'v' + it.i"
        :x="it.cx - it.bw / 2"
        :y="it.volTop"
        :width="it.bw"
        :height="it.volH"
        :class="['kl-vol', it.up ? 'up' : 'down']"
      />

      <!-- 蜡烛 -->
      <g>
        <template v-for="it in geom.items" :key="it.i">
          <line
            :x1="it.cx"
            :x2="it.cx"
            :y1="it.yHigh"
            :y2="it.yLow"
            :class="['kl-wick', it.up ? 'up' : 'down']"
          />
          <rect
            :x="it.cx - it.bw / 2"
            :y="it.bodyTop"
            :width="it.bw"
            :height="it.bodyH"
            :class="['kl-body', it.up ? 'up' : 'down']"
          />
        </template>
      </g>

      <!-- 均线 -->
      <polyline v-if="geom.ma5" :points="geom.ma5" class="kl-ma5" />
      <polyline v-if="geom.ma10" :points="geom.ma10" class="kl-ma10" />

      <!-- 最新价虚线 -->
      <line x1="0" :x2="W - PAD_R" :y1="geom.lastY" :y2="geom.lastY" class="kl-lastline" />
      <rect :x="W - PAD_R + 2" :y="geom.lastY - 9" :width="PAD_R - 6" height="18" :class="['kl-lastbg', geom.up ? 'up' : 'down']" />
      <text :x="W - PAD_R + 6" :y="geom.lastY + 4" class="kl-lasttxt">{{ fmtPrice(geom.lastPrice) }}</text>

      <!-- 悬停十字线 -->
      <line
        v-if="hoverItem"
        :x1="hoverItem.cx"
        :x2="hoverItem.cx"
        y1="0"
        :y2="geom.volBase"
        class="kl-cross"
      />
    </svg>
  </div>
  <div v-else class="empty">无 K 线数据</div>
</template>

<style scoped>
.kl { width: 100%; }
.kl-head { font-size: 12px; margin-bottom: 4px; min-height: 18px; }
.kl-oh { font-variant-numeric: tabular-nums; }
.kl-svg { width: 100%; height: auto; display: block; cursor: crosshair; }
.kl-grid line { stroke: var(--border); stroke-width: 1; }
.kl-axis { font-size: 11px; fill: var(--dim-2); }
.kl-wick.up, .kl-body.up { stroke: var(--green); }
.kl-wick.down, .kl-body.down { stroke: var(--red); }
.kl-wick { stroke-width: 1; }
.kl-body.up { fill: var(--green); }
.kl-body.down { fill: var(--red); }
.kl-vol.up { fill: var(--green); opacity: 0.35; }
.kl-vol.down { fill: var(--red); opacity: 0.35; }
.kl-ma5 { fill: none; stroke: var(--blue); stroke-width: 1.2; }
.kl-ma10 { fill: none; stroke: var(--yellow); stroke-width: 1.2; }
.kl-lastline { stroke: var(--dim-2); stroke-width: 1; stroke-dasharray: 4 3; }
.kl-lastbg.up { fill: var(--green); }
.kl-lastbg.down { fill: var(--red); }
.kl-lasttxt { font-size: 11px; fill: #fff; }
.kl-cross { stroke: var(--dim-2); stroke-width: 1; stroke-dasharray: 3 3; }
.up { color: var(--green); }
.down { color: var(--red); }
</style>
