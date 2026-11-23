// 交易台账规范化：
// - wholesale（批发转售）与 visitor（游客最终购买）货权不同，必须分列，不能相加为最终消费；
// - 同 lot、同经营户、等额的 dock 与 online 记录是同一成交的渠道再报，只计一次；
// - 不能唯一解释的记录进入待核队列，不静默丢弃也不直接计入。

import { toInt } from './csv.mjs';

/**
 * @typedef {Object} CanonicalSale
 * @property {string} receipt            保留的原始凭证号（再报对保留 dock 凭证）
 * @property {string[]} mergedReceipts   被合并的全部凭证号
 * @property {string} lot
 * @property {string} operator
 * @property {string} port
 * @property {number} week               业务发生周（交易周，不是 known_week）
 * @property {'visitor'|'wholesale'} buyer
 * @property {number} amount
 * @property {'confirmed'|'duplicate'|'review'} status
 * @property {string} note
 */

/**
 * 规范化交易表。
 * @param {Array<Record<string,string>>} rows transactions 表行
 * @returns {{ sales: CanonicalSale[], review: object[], quality: object }}
 */
export function canonicalizeTransactions(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.lot}|${row.operator}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const sales = [];
  const review = [];
  const quality = {
    原始凭证数: rows.length,
    确认成交数: 0,
    渠道再报合并数: 0,
    待核记录数: 0,
    批发笔数: 0,
    游客笔数: 0,
  };

  const pushReview = (row, reason) => {
    quality.待核记录数 += 1;
    review.push({ receipt: row.receipt, lot: row.lot, operator: row.operator, reason, raw: row });
  };

  for (const [key, groupRows] of groups) {
    // 第一步：在同货批同经营户内，寻找恰好一条 dock 与一条 online、
    // 等额且 buyer 一致的成对记录，认定为同一成交的渠道再报。
    const remaining = groupRows.slice();
    const used = new Set();
    const pairings = [];
    for (let i = 0; i < remaining.length; i += 1) {
      if (used.has(i)) continue;
      const a = remaining[i];
      if (a.channel !== 'dock') continue;
      const j = remaining.findIndex((b, idx) =>
        idx !== i && !used.has(idx) && b.channel === 'online'
        && b.net_amount === a.net_amount && b.buyer === a.buyer);
      if (j >= 0) {
        used.add(i);
        used.add(j);
        pairings.push([a, remaining[j]]);
      }
    }

    for (const [dock, online] of pairings) {
      if (!['visitor', 'wholesale'].includes(dock.buyer)) {
        [dock, online].forEach(r => pushReview(r, `未约定的 buyer 取值 ${dock.buyer}`));
        continue;
      }
      const noteParts = [];
      if (dock.port !== online.port) noteParts.push(`港口不一致(${dock.port}/${online.port})`);
      if (dock.week !== online.week) noteParts.push(`交易周不一致(${dock.week}/${online.week})`);
      if (dock.known_week !== online.known_week) noteParts.push('上报周不同');
      sales.push({
        receipt: dock.receipt,
        mergedReceipts: [dock.receipt, online.receipt],
        lot: dock.lot,
        operator: dock.operator,
        port: dock.port,
        week: toInt(dock.week, 'week'),
        buyer: dock.buyer,
        amount: toInt(dock.net_amount, 'net_amount'),
        status: 'duplicate',
        note: noteParts.length ? `渠道再报，${noteParts.join('，')}` : '渠道再报（dock/online 同一成交）',
      });
      quality.渠道再报合并数 += 1;
    }

    // 第二步：未配成再报对的记录，按 (渠道, buyer, 金额, 交易周) 去重判重。
    // 完全同键的多条记录无法唯一解释，整组待核；其余各自是独立成交。
    const leftovers = remaining.filter((_, idx) => !used.has(idx));
    const seen = new Map();
    const ambiguous = new Set();
    for (const row of leftovers) {
      const dedupKey = [row.channel, row.buyer, row.net_amount, row.week, row.port].join('|');
      if (seen.has(dedupKey)) {
        ambiguous.add(seen.get(dedupKey));
        ambiguous.add(row);
      } else {
        seen.set(dedupKey, row);
      }
    }
    for (const row of leftovers) {
      if (ambiguous.has(row)) {
        pushReview(row, '同货批同经营户存在无法唯一解释的重复记录');
        continue;
      }
      if (!['visitor', 'wholesale'].includes(row.buyer)) {
        pushReview(row, `未约定的 buyer 取值 ${row.buyer}`);
        continue;
      }
      sales.push({
        receipt: row.receipt,
        mergedReceipts: [row.receipt],
        lot: row.lot,
        operator: row.operator,
        port: row.port,
        week: toInt(row.week, 'week'),
        buyer: row.buyer,
        amount: toInt(row.net_amount, 'net_amount'),
        status: 'confirmed',
        note: leftovers.length > 1 ? '同货批另有不同 buyer/金额的独立成交，已分别计入' : '',
      });
    }
  }

  sales.sort((a, b) => a.receipt.localeCompare(b.receipt));
  review.sort((a, b) => a.receipt.localeCompare(b.receipt));
  quality.确认成交数 = sales.length;
  quality.批发笔数 = sales.filter(s => s.buyer === 'wholesale').length;
  quality.游客笔数 = sales.filter(s => s.buyer === 'visitor').length;
  return { sales, review, quality, groupCount: groups.size };
}

/**
 * 按经营户 × 周汇总规范化成交，批发与游客分列。
 * @returns {Map<string, Map<number, {visitor:number, wholesale:number, receipts:string[]}>>}
 */
export function weeklyRevenue(sales) {
  const byOperator = new Map();
  for (const sale of sales) {
    if (!byOperator.has(sale.operator)) byOperator.set(sale.operator, new Map());
    const byWeek = byOperator.get(sale.operator);
    if (!byWeek.has(sale.week)) byWeek.set(sale.week, { visitor: 0, wholesale: 0, receipts: [] });
    const cell = byWeek.get(sale.week);
    cell[sale.buyer] += sale.amount;
    cell.receipts.push(sale.receipt);
  }
  return byOperator;
}
