import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeTransactions, weeklyRevenue } from '../src/canonical.mjs';

const tx = (...rows) => {
  const header = ['receipt', 'lot', 'operator', 'port', 'week', 'channel', 'buyer', 'net_amount', 'known_week'];
  return rows.map(cells => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
};

test('等额 dock/online 同货批同经营户识别为渠道再报，只计一次', () => {
  const rows = tx(
    ['TX3', 'L3', 'V3', 'P2', '5', 'dock', 'visitor', '190', '5'],
    ['TX4', 'L3', 'V3', 'P2', '5', 'online', 'visitor', '190', '6'],
  );
  const { sales, review, quality } = canonicalizeTransactions(rows);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].status, 'duplicate');
  assert.deepEqual(sales[0].mergedReceipts, ['TX3', 'TX4']);
  assert.equal(review.length, 0);
  assert.equal(quality.渠道再报合并数, 1);
});

test('同货批的批发再售与游客零售是不同成交，分别计入且不进待核', () => {
  const rows = tx(
    ['TX1', 'L1', 'V2', 'P1', '4', 'cooperative', 'wholesale', '420', '4'],
    ['TX2', 'L1', 'V2', 'P1', '4', 'dock', 'visitor', '570', '4'],
  );
  const { sales, review } = canonicalizeTransactions(rows);
  assert.equal(sales.length, 2);
  assert.equal(review.length, 0);
  assert.deepEqual(sales.map(s => s.buyer).sort(), ['visitor', 'wholesale']);
});

test('同键重复且无法唯一解释的记录进入待核，不静默计入', () => {
  const rows = tx(
    ['A', 'L9', 'V9', 'P1', '5', 'dock', 'visitor', '100', '5'],
    ['B', 'L9', 'V9', 'P1', '5', 'dock', 'visitor', '100', '5'],
  );
  const { sales, review } = canonicalizeTransactions(rows);
  assert.equal(sales.length, 0);
  assert.equal(review.length, 2);
  assert.match(review[0].reason, /无法唯一解释/);
});

test('周汇总按 buyer 分列，批发不混入游客口径', () => {
  const rows = tx(
    ['TX1', 'L1', 'V2', 'P1', '4', 'cooperative', 'wholesale', '420', '4'],
    ['TX2', 'L1', 'V2', 'P1', '4', 'dock', 'visitor', '570', '4'],
  );
  const weekly = weeklyRevenue(canonicalizeTransactions(rows).sales);
  const cell = weekly.get('V2').get(4);
  assert.equal(cell.visitor, 570);
  assert.equal(cell.wholesale, 420);
});

test('dock/online 金额不等时不能配对，各自作为独立成交', () => {
  const rows = tx(
    ['A', 'L9', 'V9', 'P1', '5', 'dock', 'visitor', '100', '5'],
    ['B', 'L9', 'V9', 'P1', '5', 'online', 'visitor', '120', '5'],
  );
  const { sales, review } = canonicalizeTransactions(rows);
  assert.equal(sales.length, 2);
  assert.equal(review.length, 0);
});
