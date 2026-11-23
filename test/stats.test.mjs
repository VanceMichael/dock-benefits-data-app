import assert from 'node:assert/strict';
import test from 'node:test';
import { distribution, linearTrend, mean, mulberry32, quantile, variance } from '../src/stats.mjs';

test('均值/方差/分位数在空样本与小样本上的边界行为', () => {
  assert.equal(mean([]), null);
  assert.equal(variance([1]), null);
  assert.equal(quantile([], 0.5), null);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(variance([1, 2, 3]), 1);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
});

test('分布描述给出可比样本量与四分位', () => {
  const d = distribution([10, 20, 30, 40]);
  assert.equal(d.n, 4);
  assert.equal(d.median, 25);
  assert.equal(d.min, 10);
  assert.equal(d.max, 40);
});

test('OLS 趋势线与可复现随机数', () => {
  const trend = linearTrend([{ x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 6 }]);
  assert.equal(trend.slope, 2);
  assert.equal(trend.intercept, 0);
  const a = mulberry32(42);
  const b = mulberry32(42);
  assert.equal(a(), b());
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});
