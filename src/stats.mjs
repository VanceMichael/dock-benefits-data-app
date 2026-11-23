// 描述统计与可比较口径工具。均值/分位数只在明确的可比人群、时间、品类上计算，
// 停业、缺报、停航周剔除并单独计数，绝不用零值填充。

/** 算术平均（样本为空返回 null）。 */
export function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 经验分位数（线性插值，与常见统计教材一致）。 */
export function quantile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] === undefined) return sorted[base];
  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

/** 样本方差（n-1）。 */
export function variance(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  return values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
}

/**
 * 一组经营户-周收入观测的分布描述。
 * @param {number[]} values
 */
export function distribution(values) {
  if (!values.length) {
    return { n: 0, mean: null, p25: null, median: null, p75: null, min: null, max: null };
  }
  return {
    n: values.length,
    mean: round2(mean(values)),
    p25: round2(quantile(values, 0.25)),
    median: round2(quantile(values, 0.5)),
    p75: round2(quantile(values, 0.75)),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** 普通最小二乘斜率与截距（用于通车前趋势线）。 */
export function linearTrend(points) {
  const n = points.length;
  if (n < 2) return { slope: null, intercept: null };
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const xBar = mean(xs);
  const yBar = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - xBar) * (ys[i] - yBar);
    den += (xs[i] - xBar) ** 2;
  }
  if (den === 0) return { slope: null, intercept: null };
  const slope = num / den;
  return { slope: round4(slope), intercept: round4(yBar - slope * xBar) };
}

/** 可复现的 PRNG（mulberry32），保证季度会与复核得到同一组自助样本。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 百分位置信区间。 */
export function percentileInterval(bootstrapValues, alpha) {
  if (bootstrapValues.length < 2) return { low: null, high: null };
  const sorted = bootstrapValues.slice().sort((a, b) => a - b);
  return {
    low: round2(quantile(sorted, alpha / 2)),
    high: round2(quantile(sorted, 1 - alpha / 2)),
  };
}

export function round2(x) {
  return x === null || x === undefined ? null : Math.round(x * 100) / 100;
}

export function round4(x) {
  return x === null || x === undefined ? null : Math.round(x * 1e4) / 1e4;
}
