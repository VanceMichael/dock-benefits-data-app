// 交接资料的 CSV/JSON 读取与引用校验。约定：UTF-8、逗号分隔、无引号、无内嵌换行。

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/**
 * 按约定字段解析单张表。空字段保留为空字符串；'-' 由调用方按"不适用"解释。
 * @returns {Array<Record<string,string>>}
 */
export function parseTable(content, fields, table) {
  const lines = content.trimEnd().split(/\r?\n/);
  const header = lines.shift().split(',');
  if (header.length !== fields.length || header.some((field, index) => field !== fields[index])) {
    throw new Error(`${table} 的表头与格式约定不一致`);
  }
  return lines.map((line, index) => {
    const cells = line.split(',');
    if (cells.length !== fields.length || line.includes('"')) {
      throw new Error(`${table} 第 ${index + 2} 行不是约定的字段格式`);
    }
    return Object.fromEntries(fields.map((field, position) => [field, cells[position]]));
  });
}

/** 校验外键引用：空串与 '-' 允许放行，其余取值必须在目标表键集合中。 */
export function checkLinks(tables, links) {
  for (const [table, field, target, key] of links) {
    const keys = new Set(tables[target].map(row => row[key]));
    for (const row of tables[table]) {
      const value = row[field];
      if (value !== '' && value !== '-' && !keys.has(value)) {
        throw new Error(`${table}.${field} 的 ${value} 在 ${target}.${key} 中无对应记录`);
      }
    }
  }
}

/** 整数解析：空串返回 null（缺报/未提供与数值 0 区分）。 */
export function toInt(value, label = '数值') {
  if (value === '' || value === undefined) return null;
  if (!/^-?\d+$/.test(value)) throw new Error(`${label} "${value}" 不是整数`);
  return Number(value);
}

/** 十进制金额解析（本资料均为整数，保留两位小数的兼容入口）。 */
export function toAmount(value, label = '金额') {
  if (value === '' || value === undefined) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(value)) throw new Error(`${label} "${value}" 不是约定金额`);
  return Number(value);
}

/**
 * 装载一个资料目录下的全部表，同时做表头与引用校验，并留存每个文件的哈希，
 * 供季度会原口径回查。
 */
export async function loadBundle(source, { check = true } = {}) {
  const format = JSON.parse(await readFile(new URL('format.json', source), 'utf8'));
  const tables = {};
  const files = [];
  for (const [name, fields] of Object.entries(format.tables)) {
    const url = new URL(`${name}.csv`, source);
    const content = await readFile(url, 'utf8');
    tables[name] = parseTable(content, fields, name);
    if (tables[name].length === 0) throw new Error(`${name} 没有交接记录`);
    files.push({
      table: name,
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  if (check) checkLinks(tables, format.links);
  return { format, tables, files };
}
