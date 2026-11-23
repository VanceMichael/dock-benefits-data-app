// 对照港分流评估：经新桥访问数 / 观测流量。
// 有足够分流证据的对照港不能当作"完全未受影响"，需从干净对照组剔除并单独标注。

import { toInt } from './csv.mjs';

/**
 * 计算每个港口在评估窗口内的分流比率与逐周序列。
 * @param {object[]} visits      visits 表
 * @param {object[]} ports       ports 表
 * @param {{first:number,last:number}} window 评估窗口（取通车后窗口）
 * @param {number} threshold     fund.spillover_threshold（如 0.20）
 */
export function assessSpillover(visits, ports, window, threshold) {
  const treatedPorts = new Set(
    ports.filter(p => p.opening_week !== '').map(p => p.port));

  const byPort = new Map();
  for (const row of visits) {
    const week = toInt(row.week, 'week');
    if (!byPort.has(row.port)) byPort.set(row.port, []);
    byPort.get(row.port).push({
      week,
      viaNewBridge: toInt(row.via_new_bridge, 'via_new_bridge'),
      traffic: toInt(row.traffic, 'traffic'),
      closureDays: toInt(row.closure_days, 'closure_days'),
      knownWeek: toInt(row.known_week, 'known_week'),
    });
  }

  const results = [];
  for (const port of ports.map(p => p.port)) {
    const series = (byPort.get(port) ?? []).slice().sort((a, b) => a.week - b.week);
    const inWindow = series.filter(w => w.week >= window.first && w.week <= window.last);
    const sumVia = inWindow.reduce((acc, w) => acc + w.viaNewBridge, 0);
    const sumTraffic = inWindow.reduce((acc, w) => acc + w.traffic, 0);
    const windowRatio = sumTraffic === 0 ? null : sumVia / sumTraffic;

    // 任一周（观测流量为正）跨过门槛即视为"有足够分流证据"，
    // 避免低流量周的比率噪音，同时不漏掉通车当周的集中分流。
    const breachWeeks = inWindow
      .filter(w => w.traffic > 0 && w.viaNewBridge / w.traffic >= threshold)
      .map(w => ({
        week: w.week,
        ratio: w.viaNewBridge / w.traffic,
        viaNewBridge: w.viaNewBridge,
        traffic: w.traffic,
        knownWeek: w.knownWeek,
      }));

    const isTreated = treatedPorts.has(port);
    results.push({
      port,
      treated: isTreated,
      window: { ...window },
      windowRatio: windowRatio === null ? null : round6(windowRatio),
      viaNewBridge: sumVia,
      traffic: sumTraffic,
      threshold,
      breachWeeks,
      spilloverEvidence: !isTreated && breachWeeks.length > 0,
      cleanControl: !isTreated && breachWeeks.length === 0,
      weekly: inWindow.map(w => ({
        week: w.week,
        ratio: w.traffic === 0 ? null : round6(w.viaNewBridge / w.traffic),
        viaNewBridge: w.viaNewBridge,
        traffic: w.traffic,
        closureDays: w.closureDays,
        knownWeek: w.knownWeek,
      })),
    });
  }
  return results;
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

/** 干净对照港列表（未通车且无跨门槛分流证据）。 */
export function cleanControlPorts(spillover) {
  return spillover.filter(s => s.cleanControl).map(s => s.port);
}

/** 有分流证据、被移出干净对照组的港口。 */
export function contaminatedPorts(spillover) {
  return spillover.filter(s => s.spilloverEvidence).map(s => s.port);
}
