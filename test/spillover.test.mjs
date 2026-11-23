import assert from 'node:assert/strict';
import test from 'node:test';
import { assessSpillover, cleanControlPorts, contaminatedPorts } from '../src/spillover.mjs';

const ports = [
  { port: 'P1', area: 'A', opening_week: '5', eligible_reference: 'false' },
  { port: 'P3', area: 'B', opening_week: '', eligible_reference: 'true' },
  { port: 'P4', area: 'C', opening_week: '', eligible_reference: 'true' },
];

const visits = [
  // P3 通车后窗口内一周 60/140 ≈ 0.429 跨过 0.20 门槛
  { port: 'P3', week: '5', via_new_bridge: '60', traffic: '140', closure_days: '0', known_week: '8' },
  { port: 'P3', week: '6', via_new_bridge: '8', traffic: '113', closure_days: '1', known_week: '6' },
  // P4 全程低于门槛
  { port: 'P4', week: '5', via_new_bridge: '7', traffic: '83', closure_days: '0', known_week: '5' },
  { port: 'P4', week: '6', via_new_bridge: '9', traffic: '118', closure_days: '1', known_week: '6' },
  // 处理港 P1 即使比率高也不参与对照港判定
  { port: 'P1', week: '5', via_new_bridge: '73', traffic: '210', closure_days: '0', known_week: '5' },
];

test('跨门槛的对照港移出干净对照组，处理港不参与分流判定', () => {
  const result = assessSpillover(visits, ports, { first: 5, last: 6 }, 0.2);
  const byPort = new Map(result.map(r => [r.port, r]));
  assert.equal(byPort.get('P3').spilloverEvidence, true);
  assert.equal(byPort.get('P3').cleanControl, false);
  assert.deepEqual(byPort.get('P3').breachWeeks.map(w => w.week), [5]);
  assert.equal(byPort.get('P4').cleanControl, true);
  assert.equal(byPort.get('P1').spilloverEvidence, false);
  assert.deepEqual(cleanControlPorts(result), ['P4']);
  assert.deepEqual(contaminatedPorts(result), ['P3']);
});

test('窗口比率按总量口径计算并保留逐周序列', () => {
  const result = assessSpillover(visits, ports, { first: 5, last: 6 }, 0.2);
  const p3 = result.find(r => r.port === 'P3');
  assert.equal(p3.viaNewBridge, 68);
  assert.equal(p3.traffic, 253);
  assert.equal(p3.windowRatio, Math.round((68 / 253) * 1e6) / 1e6);
});
