import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenIndex, buildRoster, openStatus, portAtWeek } from '../src/roster.mjs';

const moves = [
  { event: 'M1', operator: 'V2', household: 'F1', from_port: 'P1', to_port: 'P2', effective_week: '5', verified_week: '7' },
  { event: 'M2', operator: 'V3', household: 'F1', from_port: 'P2', to_port: 'P2', effective_week: '1', verified_week: '7' },
];

test('迁转不新增经营户，归属按有效周滚动，核实日期单独保留', () => {
  const { operators, households } = buildRoster(moves);
  assert.deepEqual([...operators.keys()], ['V2', 'V3']);
  const v2 = operators.get('V2');
  assert.equal(portAtWeek(v2, 4), 'P1');
  assert.equal(portAtWeek(v2, 5), 'P2');
  assert.equal(v2.moves[0].verifiedWeek, 7);
  // 同一家庭 F1 下两个经营点共用额度。
  assert.deepEqual(households.get('F1'), ['V2', 'V3']);
});

test('营业状态三种取值分别解释，省略不代表停业', () => {
  const index = buildOpenIndex([
    { operator: 'V3', week: '3', declared: 'not-open', known_week: '3' },
    { operator: 'V5', week: '7', declared: 'no-report', known_week: '7' },
    { operator: 'V2', week: '7', declared: 'weather-closed', known_week: '7' },
  ]);
  assert.equal(openStatus(index, 'V3', 3).label, '实际停业');
  assert.equal(openStatus(index, 'V5', 7).label, '缺报');
  assert.equal(openStatus(index, 'V2', 7).label, '风浪停航');
  assert.equal(openStatus(index, 'V2', 1), null);
});
