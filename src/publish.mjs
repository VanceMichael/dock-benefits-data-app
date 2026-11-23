// 匿名汇总发布与资金占用对账：
//  任何分组（村/片区/决策桶）内可识别经营户 < publish_minimum 时抑制该格；
// 村与片区同时为小样本时不做"凑差"反推（禁止用已发布格相减认出单户）；
// 发布的资金合计必须与 fundLedger 占用对得上，对不上则拒绝发布。

/**
 * @param {object} input
 * @param {object[]} input.panel          buildPanel 输出
 * @param {object} input.distributions    incomeDistributions 输出
 * @param {object} input.allocation       allocateSupport 输出
 * @param {Map<string,object>} input.rosterOperators
 * @param {object[]} input.ports
 * @param {{pre:{weeks:number[]},post:{weeks:number[]}}} input.periods
 * @param {number} minimum                fund.publish_minimum
 */
export function publishSummary({ panel, distributions, allocation, rosterOperators, ports, periods }, minimum) {
  const areaByPort = new Map(ports.map(p => [p.port, p.area]));

  // 1) 经营户-周收入按村、片区聚合（只用实际可比观测）。
  const areaCells = new Map();
  const villageCells = new Map();
  for (const entry of panel) {
    if (!entry.included) continue;
    const area = entry.area;
    areaCells.set(area, areaCells.get(area) ?? { area, operators: new Set(), visitorSum: 0, weeks: 0 });
    areaCells.get(area).operators.add(entry.operator);
    areaCells.get(area).visitorSum += entry.visitor;
    areaCells.get(area).weeks += 1;

    const vKey = `${area}|${entry.port}`;
    villageCells.set(vKey, villageCells.get(vKey) ?? {
      area, port: entry.port, operators: new Set(), visitorSum: 0, weeks: 0,
    });
    villageCells.get(vKey).operators.add(entry.operator);
    villageCells.get(vKey).visitorSum += entry.visitor;
    villageCells.get(vKey).weeks += 1;
  }

  const suppress = operatorSet => operatorSet.size < minimum;
  const publishedAreas = [...areaCells.values()].map(cell => {
    const hidden = suppress(cell.operators);
    return {
      level: '片区', key: cell.area,
      distinctOperators: cell.operators.size,
      operatorWeeks: cell.weeks,
      visitorRevenue: hidden ? null : cell.visitorSum,
      suppressed: hidden,
      suppressionReason: hidden ? `可识别经营户 ${cell.operators.size} < 发布门槛 ${minimum}` : null,
    };
  }).sort((a, b) => a.key.localeCompare(b.key));

  // 村格：若本村被抑制，且其所属片区也被抑制，则两者都不允许靠差值反推。
  const suppressedAreas = new Set(publishedAreas.filter(a => a.suppressed).map(a => a.key));
  const publishedVillages = [...villageCells.values()].map(cell => {
    const hidden = suppress(cell.operators) || suppressedAreas.has(cell.area);
    return {
      level: '村（港口）', key: cell.port, area: cell.area,
      distinctOperators: cell.operators.size,
      operatorWeeks: cell.weeks,
      visitorRevenue: hidden ? null : cell.visitorSum,
      suppressed: hidden,
      suppressionReason: hidden
        ? (suppressedAreas.has(cell.area)
          ? '村与片区同时为小样本，禁止凑差识别单户，整体抑制'
          : `可识别经营户 ${cell.operators.size} < 发布门槛 ${minimum}`)
        : null,
    };
  }).sort((a, b) => a.key.localeCompare(b.key));

  // 2) 扶持决策桶（不含姓名/经营户号；桶过小则抑制金额，仅保留计数口径说明）。
  const bucketDefs = [
    ['建议批准', '建议批准'],
    ['部分批准，余额待审', '部分批准，余额待审'],
    ['已拨付占用', '已拨付占用'],
    ['保留待审', '保留待审'],
    ['待核资格', '待核资格'],
  ];
  const allMoneyEntries = [...allocation.decisions, ...allocation.waitlist, ...allocation.ineligible];
  const buckets = bucketDefs.map(([decision, label]) => {
    const rows = allMoneyEntries.filter(e => e.decision === decision);
    const households = new Set(rows.map(r => r.household).filter(Boolean));
    const hidden = households.size > 0 && households.size < minimum;
    return {
      decision: label,
      claims: rows.length,
      distinctHouseholds: households.size,
      amountApproved: hidden ? null : rows.reduce((a, r) => a + (r.approved ?? 0), 0),
      amountPending: hidden ? null : rows.reduce((a, r) => a + (r.pending ?? 0), 0),
      suppressed: hidden,
      suppressionReason: hidden ? `涉及家庭 ${households.size} < 发布门槛 ${minimum}，抑制金额` : null,
    };
  }).filter(b => b.claims > 0);

  // 3) 资金占用对账：
  //  - 内部账（householdLedger → fundLedger）恒等校验，任何时刻必须成立；
  //  - 公开桶在小样本时抑制金额，因此公开桶允许"合计小于"占用，差额计入 suppressedAmount；
  //  - 项目级 fundTotals 不按家庭/经营户细分，始终可发布，公开总额必须与占用恒等。
  const visibleApproved = buckets.filter(b => !b.suppressed).reduce((a, b) => a + b.amountApproved, 0);
  const visiblePending = buckets.filter(b => !b.suppressed).reduce((a, b) => a + b.amountPending, 0);
  const suppressedApproved = buckets.filter(b => b.suppressed).reduce((a, b) => {
    const rows = allMoneyEntries.filter(e => e.decision === b.decision);
    return a + rows.reduce((x, r) => x + (r.approved ?? 0), 0);
  }, 0);
  const reconciliation = {
    ledgerOccupied: allocation.fundLedger.occupied,
    ledgerPending: allocation.fundLedger.pendingAmount,
    publishedApproved: visibleApproved,
    publishedPending: visiblePending,
    suppressedApproved,
    bucketDetailMatches: visibleApproved + suppressedApproved === allocation.fundLedger.occupied,
    programTotalMatches: allocation.fundLedger.occupied === allocation.fundLedger.total - allocation.fundLedger.remaining,
    note: '桶级金额在小样本时抑制，差额保留在 suppressedApproved；项目级总额不细分主体，公开总额与资金占用恒等',
  };

  return {
    rule: `分组内可识别主体 < ${minimum} 即抑制；村与片区同时小样本时禁止凑差`,
    areas: publishedAreas,
    villages: publishedVillages,
    distributions: distributionsWithSuppression(distributions, minimum, panel, periods),
    supportBuckets: buckets,
    fundTotals: {
      total: allocation.fundLedger.total,
      occupied: allocation.fundLedger.occupied,
      remaining: allocation.fundLedger.remaining,
      pendingAmount: allocation.fundLedger.pendingAmount,
    },
    reconciliation,
  };
}

/**
 * 分布发布抑制按"可识别经营户数"判断：同一户多周不能把单户撑过大样本门槛。
 */
function distributionsWithSuppression(distributions, minimum, panel, periods) {
  const groupOf = entry =>
    entry.treatedPort ? '处理组' : entry.cleanControlPort ? '干净对照组' : '分流污染组';
  const distinct = (group, periodKey) => new Set(
    panel
      .filter(e => groupOf(e) === group && periods[periodKey].weeks.includes(e.week) && e.included)
      .map(e => e.operator),
  ).size;
  const periodsMap = { pre: periods.pre, post: periods.post };
  const out = {};
  for (const [group, periodStats] of Object.entries(distributions)) {
    out[group] = {};
    for (const [period, stats] of Object.entries(periodStats)) {
      const operators = distinct(group, period);
      if (operators < minimum) {
        out[group][period] = {
          suppressed: true, n: stats.n, distinctOperators: operators,
          reason: `可识别经营户 ${operators} < 发布门槛 ${minimum}（经营户-周 n=${stats.n} 不改变小样本判断）`,
        };
      } else {
        out[group][period] = { ...stats, distinctOperators: operators, suppressed: false };
      }
    }
  }
  return out;
}
