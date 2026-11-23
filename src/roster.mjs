// 经营户名册：迁摊不产生新经营户；归属按迁转有效周，核实日期按 verified_week；
// operator-open 的 not-open / no-report / weather-closed 分别对待，省略不代表失业。

import { toInt } from './csv.mjs';

/**
 * 构建经营户名册与家庭额度主体。
 * @param {object[]} movements movements 表
 * @returns {{
 *   operators: Map<string, object>, households: Map<string, string[]>, moves: object[]
 * }}
 */
export function buildRoster(movements) {
  const operators = new Map();
  const moves = movements.map(row => ({
    event: row.event,
    operator: row.operator,
    household: row.household,
    fromPort: row.from_port,
    toPort: row.to_port,
    effectiveWeek: toInt(row.effective_week, 'effective_week'),
    verifiedWeek: toInt(row.verified_week, 'verified_week'),
  }));

  for (const move of moves) {
    if (!operators.has(move.operator)) {
      operators.set(move.operator, {
        operator: move.operator,
        household: move.household,
        basePort: move.fromPort,
        currentPort: move.toPort,
        moves: [],
      });
    }
    const record = operators.get(move.operator);
    record.moves.push(move);
  }

  // 同一经营户可能多条迁转：按有效周排序后滚动归属，当前归属取最后一条的目标港。
  for (const record of operators.values()) {
    record.moves.sort((a, b) => a.effectiveWeek - b.effectiveWeek);
    record.currentPort = record.moves.at(-1).toPort;
  }

  const households = new Map();
  for (const record of operators.values()) {
    if (!households.has(record.household)) households.set(record.household, []);
    households.get(record.household).push(record.operator);
  }
  return { operators, households, moves };
}

/**
 * 经营户在指定周的有效港口（迁转以 effective_week 为准）。
 */
export function portAtWeek(operatorRecord, week) {
  let port = operatorRecord.basePort;
  for (const move of operatorRecord.moves) {
    if (week >= move.effectiveWeek) port = move.toPort;
  }
  return port;
}

/**
 * 解析 operator-open 表为 operator×week 的状态索引。
 * 状态语义：
 *  - not-open       实际停业（该周不纳入可比较样本，不作为零收入）
 *  - no-report      缺报（样本剔除并单独披露，不用零值填充）
 *  - weather-closed 风浪停航（剔除样本，作为外部冲击单列）
 * 省略 = 无状态记录，结合交易簿判断，不能当成停业。
 */
export function buildOpenIndex(openRows) {
  const index = new Map();
  for (const row of openRows) {
    const week = toInt(row.week, 'week');
    if (!index.has(row.operator)) index.set(row.operator, new Map());
    index.get(row.operator).set(week, {
      declared: row.declared,
      knownWeek: toInt(row.known_week, 'known_week'),
    });
  }
  return index;
}

const STATUS_LABEL = {
  'not-open': '实际停业',
  'no-report': '缺报',
  'weather-closed': '风浪停航',
};

export function openStatus(openIndex, operator, week) {
  const hit = openIndex.get(operator)?.get(week);
  if (!hit) return null;
  return { ...hit, label: STATUS_LABEL[hit.declared] ?? hit.declared };
}

export { STATUS_LABEL };
