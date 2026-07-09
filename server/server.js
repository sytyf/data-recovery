import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const uploadDir = path.join(rootDir, 'uploads');
const generatedDir = path.join(rootDir, 'generated');
const scriptDir = path.join(rootDir, 'scripts');
const distDir = path.join(rootDir, 'dist');
const localConfigPaths = [
  path.join(rootDir, 'config', 'recovery.local.json'),
  path.join(rootDir, 'config', 'recovery_local.json'),
  path.join(rootDir, 'config', 'recovery.local.example.json')
];
const envPath = path.join(rootDir, '.env');
const jobs = new Map();

function parseEnvValue(value) {
  const trimmed = String(value || '').trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    process.env[key] = parseEnvValue(normalized.slice(separator + 1));
  }
}

loadDotEnv(envPath);

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(generatedDir, { recursive: true });

const scriptMap = {
  continuous: 'copy_hive_partitions.sh',
  single: 'file_to_prodb_optimized.sh',
  cross: 'prodb_dm_to_target_partitions.sh'
};

const statusText = {
  pending: '待执行',
  running: '执行中',
  completed: '已完成',
  failed: '失败'
};

function readLocalRecoveryConfig() {
  const localConfigPath = localConfigPaths.find((item) => fs.existsSync(item));
  if (!localConfigPath) return {};
  try {
    return JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
  } catch (error) {
    throw new Error(`本地恢复配置解析失败：${localConfigPath}，${error.message}`);
  }
}

function getLocalPathConfig() {
  const localConfig = readLocalRecoveryConfig();
  return {
    maskedSourceRoot: process.env.RECOVERY_MASKED_SOURCE_ROOT || process.env.RECOVERY_SOURCE_ROOT || localConfig.maskedSourceRoot || localConfig.sourceRoot || '',
    unmaskedSourceRoot: process.env.RECOVERY_UNMASKED_SOURCE_ROOT || localConfig.unmaskedSourceRoot || localConfig.rawSourceRoot || '',
    nonPartitionSourceRoot: process.env.RECOVERY_NON_PARTITION_SOURCE_ROOT || localConfig.nonPartitionSourceRoot || '',
    stageRoot: process.env.RECOVERY_STAGE_ROOT || localConfig.stageRoot || '',
    packageRoot: process.env.DATA_PACKAGE_ROOT || process.env.RECOVERY_PACKAGE_ROOT || localConfig.packageRoot || localConfig.dataPackageRoot || ''
  };
}

function resolveSourceRoot(sourceType) {
  const localPathConfig = getLocalPathConfig();
  const normalized = sourceType === 'unmasked' ? 'unmasked' : 'masked';
  return {
    sourceType: normalized,
    sourceRoot: normalized === 'unmasked' ? localPathConfig.unmaskedSourceRoot : localPathConfig.maskedSourceRoot,
    nonPartitionSourceRoot: localPathConfig.nonPartitionSourceRoot,
    stageRoot: localPathConfig.stageRoot
  };
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendBuffer(res, code, buffer, headers = {}) {
  res.writeHead(code, {
    'Content-Length': buffer.length,
    ...headers
  });
  res.end(buffer);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const source = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
    const content = zlib.deflateRawSync(source);
    const crc = crc32(source);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(source.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(source.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cellRef(columnIndexValue, rowIndex) {
  let value = columnIndexValue + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return `${letters}${rowIndex}`;
}

function makeSheetXml(rows) {
  const rowXml = rows.map((row, rowIndex) => {
    const cells = row.map((cell, columnIndexValue) => {
      const ref = cellRef(columnIndexValue, rowIndex + 1);
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

function makeSimpleXlsx(sheetName, rows) {
  return makeZip([
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content: makeSheetXml(rows)
    }
  ]);
}

function makeRecoveryTemplateXlsx() {
  return makeSimpleXlsx('恢复清单模板', [
    ['视图名', '库名', '源表名', '数据恢复开始日期', '数据恢复结束日期'],
    ['', '', '', '', '']
  ]);
}

function makeCountSummaryXlsx(summary) {
  const rows = [
    ['视图名', '库名', '表名', '时间分区', '数据量'],
    ...summary.map((item) => [
      item.viewName || '',
      item.databaseName || '',
      item.tableName || '',
      item.statDate || '',
      String(item.count ?? 0)
    ])
  ];
  return makeSimpleXlsx('数据量回查明细', rows);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  fs.readFile(filePath, (error, data) => {
    if (error) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': contentTypes[ext] || 'application/octet-stream',
      'Content-Length': data.length
    });
    res.end(data);
  });
}

function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  if (!fs.existsSync(distDir)) {
    return sendJson(res, 404, { error: 'dist not found; run npm run build first' });
  }

  const decodedPath = decodeURIComponent(url.pathname);
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const requestedPath = path.resolve(distDir, relativePath);
  const safePath = requestedPath.startsWith(distDir) && fs.existsSync(requestedPath)
    ? requestedPath
    : path.join(distDir, 'index.html');
  return sendFile(res, safePath);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) return { fields: {}, files: {} };

  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const fields = {};
  const files = {};
  let cursor = 0;

  while (cursor < buffer.length) {
    const start = buffer.indexOf(boundary, cursor);
    if (start < 0) break;
    const headerStart = start + boundary.length + 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd < 0) break;

    const header = buffer.slice(headerStart, headerEnd).toString('utf8');
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next < 0) break;
    const content = buffer.slice(headerEnd + 4, Math.max(headerEnd + 4, next - 2));
    const name = /name="([^"]+)"/.exec(header)?.[1];
    const filename = /filename="([^"]*)"/.exec(header)?.[1];

    if (name && filename) {
      const safeName = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const filePath = path.join(uploadDir, safeName);
      fs.writeFileSync(filePath, content);
      files[name] = { filename, path: filePath };
    } else if (name) {
      fields[name] = content.toString('utf8').trim();
    }
    cursor = next;
  }

  return { fields, files };
}

function xmlDecode(value = '') {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function unzipEntry(filePath, entry) {
  const result = spawnSync('unzip', ['-p', filePath, entry], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : '';
}

function parseSharedStrings(xml) {
  const values = [];
  const items = xml.match(/<si[\s\S]*?<\/si>/g) || [];
  for (const item of items) {
    const text = [...item.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map((match) => xmlDecode(match[1]))
      .join('');
    values.push(text);
  }
  return values;
}

function columnIndex(cellRef = '') {
  const letters = cellRef.replace(/[^A-Z]/g, '');
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, index - 1);
}

function excelSerialToDate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 20000 || number > 80000) return String(value || '');
  const utc = Math.round((number - 25569) * 86400 * 1000);
  return new Date(utc).toISOString().slice(0, 10);
}

function parseSheetXml(xml, sharedStrings) {
  const rows = [];
  const rowMatches = xml.match(/<row[\s\S]*?<\/row>/g) || [];
  for (const rowXml of rowMatches) {
    const row = [];
    const cells = rowXml.match(/<c[\s\S]*?<\/c>/g) || [];
    for (const cell of cells) {
      const ref = /r="([A-Z]+[0-9]+)"/.exec(cell)?.[1] || '';
      const type = /t="([^"]+)"/.exec(cell)?.[1] || '';
      const value = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1] || '';
      const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/.exec(cell)?.[1];
      const index = columnIndex(ref);
      if (type === 's') row[index] = sharedStrings[Number(value)] || '';
      else if (type === 'inlineStr') row[index] = xmlDecode(inline || '');
      else row[index] = excelSerialToDate(xmlDecode(value));
    }
    if (row.some((cell) => String(cell || '').trim())) rows.push(row);
  }
  return rows;
}

function parseXlsx(filePath) {
  const shared = parseSharedStrings(unzipEntry(filePath, 'xl/sharedStrings.xml'));
  const workbook = unzipEntry(filePath, 'xl/workbook.xml');
  const rels = unzipEntry(filePath, 'xl/_rels/workbook.xml.rels');
  const firstSheetId = /<sheet[^>]+r:id="([^"]+)"/.exec(workbook)?.[1];
  const target = firstSheetId
    ? new RegExp(`<Relationship[^>]+Id="${firstSheetId}"[^>]+Target="([^"]+)"`).exec(rels)?.[1]
    : null;
  const sheetEntry = target ? `xl/${target.replace(/^\/?xl\//, '')}` : 'xl/worksheets/sheet1.xml';
  return parseSheetXml(unzipEntry(filePath, sheetEntry), shared);
}

function parseCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function rowsToObjects(rows) {
  const headers = (rows[0] || []).map((header) => normalizeHeader(header));
  return rows.slice(1).map((row) => {
    const item = {};
    headers.forEach((header, index) => {
      item[header] = row[index] || '';
    });
    return item;
  });
}

function normalizeHeader(header = '') {
  const value = String(header).trim().toLowerCase().replace(/\s+/g, '');
  const map = {
    '视图名': 'viewName',
    view: 'viewName',
    viewname: 'viewName',
    '库名': 'databaseName',
    db: 'databaseName',
    database: 'databaseName',
    databasename: 'databaseName',
    '源表名': 'tableName',
    '表名': 'tableName',
    table: 'tableName',
    tablename: 'tableName',
    sourcetable: 'tableName',
    '数据恢复开始日期': 'startDate',
    '开始日期': 'startDate',
    startdate: 'startDate',
    start: 'startDate',
    '数据恢复结束日期': 'endDate',
    '结束日期': 'endDate',
    enddate: 'endDate',
    end: 'endDate'
  };
  return map[value] || value;
}

function readTabularFile(file) {
  if (!file) return [];
  const ext = path.extname(file.filename).toLowerCase();
  const rows = ext === '.csv' ? parseCsv(file.path) : parseXlsx(file.path);
  return rowsToObjects(rows);
}

function formatDateParts(year, month, day) {
  const normalizedMonth = String(Number(month)).padStart(2, '0');
  const normalizedDay = String(Number(day)).padStart(2, '0');
  const normalized = `${year}-${normalizedMonth}-${normalizedDay}`;
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    return '';
  }
  return normalized;
}

function normalizeDate(value, fallback) {
  const rawValue = String(value || fallback || '').trim();
  if (!rawValue) return '';
  let match = /^(\d{4})(\d{2})(\d{2})$/.exec(rawValue);
  if (match) return formatDateParts(match[1], match[2], match[3]) || rawValue;
  match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s.*)?$/.exec(rawValue);
  if (match) return formatDateParts(match[1], match[2], match[3]) || rawValue;
  return rawValue.slice(0, 10);
}

function isExecutionEnabled() {
  return process.env.RECOVERY_EXECUTE === '1';
}

function getExecutionMeta() {
  return {
    dryRun: !isExecutionEnabled(),
    executeEnabled: isExecutionEnabled(),
    envFileLoaded: fs.existsSync(envPath),
    recoveryExecute: process.env.RECOVERY_EXECUTE || ''
  };
}

function validateIdentifier(value, label) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(value || ''))) {
    throw new Error(`${label}不合法：${value}`);
  }
}

function validateDateRange(row) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(row.endDate || '')) {
    throw new Error(`日期范围不合法：${row.startDate || '空'} 至 ${row.endDate || '空'}`);
  }
  if (row.startDate > row.endDate) throw new Error(`开始日期晚于结束日期：${row.startDate} 至 ${row.endDate}`);
}

function validateHdfsTablePath(tablePath) {
  const value = String(tablePath || '');
  if (!value || value.includes('\n') || value.includes('\r')) throw new Error(`Hive 表路径为空或非法：${value}`);
  let withoutScheme = value;
  const schemeIndex = withoutScheme.indexOf('://');
  if (schemeIndex >= 0) {
    const slashAfterAuthority = withoutScheme.indexOf('/', schemeIndex + 3);
    withoutScheme = slashAfterAuthority >= 0 ? withoutScheme.slice(slashAfterAuthority) : '/';
  }
  if (!withoutScheme || withoutScheme === '/' || withoutScheme === '.') throw new Error(`拒绝操作危险的 HDFS 表路径：${value}`);
}

function runHdfsCommand(args, options = {}) {
  const candidates = process.env.HDFS_BIN ? [[process.env.HDFS_BIN, 'dfs']] : [['hdfs', 'dfs'], ['hadoop', 'fs']];
  let lastError = null;
  for (const [bin, subcommand] of candidates) {
    const result = spawnSync(bin, [subcommand, ...args], {
      cwd: rootDir,
      encoding: 'utf8',
      env: process.env
    });
    if (result.error?.code === 'ENOENT') {
      lastError = result.error;
      continue;
    }
    if (result.status === 0 || options.allowFailure) return result;
    throw new Error(`${bin} ${subcommand} ${args.join(' ')} 执行失败：${result.stderr || result.stdout || `退出码 ${result.status}`}`);
  }
  throw new Error(`未找到 HDFS 命令：${lastError?.message || 'hdfs/hadoop 不可用'}`);
}

function runCommandAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (options.onData) options.onData(chunk);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      if (options.onData) options.onData(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ status: code, stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(' ')} 执行失败：${stderr || stdout || `退出码 ${code}`}`));
      }
    });
  });
}

async function runHdfsCommandAsync(args, options = {}) {
  const candidates = process.env.HDFS_BIN ? [[process.env.HDFS_BIN, 'dfs']] : [['hdfs', 'dfs'], ['hadoop', 'fs']];
  let lastError = null;
  for (const [bin, subcommand] of candidates) {
    try {
      return await runCommandAsync(bin, [subcommand, ...args], options);
    } catch (error) {
      if (error.code === 'ENOENT') {
        lastError = error;
        continue;
      }
      if (options.allowFailure) return { status: 1, stdout: '', stderr: error.message };
      throw error;
    }
  }
  throw new Error(`未找到 HDFS 命令：${lastError?.message || 'hdfs/hadoop 不可用'}`);
}

function hdfsTestDir(tablePath) {
  return runHdfsCommand(['-test', '-d', tablePath], { allowFailure: true }).status === 0;
}

function queryScalar(sql) {
  const output = runBeeline(['-e', sql]);
  for (const rawLine of output.split(/\r?\n/)) {
    const line = cleanBeelineLine(rawLine);
    if (line) return line;
  }
  return '';
}

function getPartitionColumn() {
  const partitionColumn = process.env.PARTITION_COLUMN || 'tx_dt';
  validateIdentifier(partitionColumn, '分区字段名');
  return partitionColumn;
}

function getSourceDatabase() {
  const sourceDatabase = process.env.SOURCE_DATABASE || 'prodb_dm';
  validateIdentifier(sourceDatabase, '源库名');
  return sourceDatabase;
}

function tableKey(row) {
  return `${row.databaseName}.${row.tableName}`;
}

function getTableLocation(databaseName, tableName) {
  validateIdentifier(databaseName, '库名');
  validateIdentifier(tableName, '表名');
  const locationColumn = process.env.TABLE_LOCATION_COLUMN || 'table_location';
  validateIdentifier(locationColumn, '表路径字段名');
  const tablePath = queryScalar(
    `SELECT ${locationColumn} FROM system.tables_v WHERE database_name='${sqlString(databaseName)}' AND table_name='${sqlString(tableName)}'`
  );
  if (!tablePath) throw new Error(`未查询到表路径：${databaseName}.${tableName}`);
  validateHdfsTablePath(tablePath);
  return tablePath;
}

function isPartitionedTable(databaseName, tableName) {
  validateIdentifier(databaseName, '库名');
  validateIdentifier(tableName, '表名');
  const count = queryScalar(
    `SELECT count(1) FROM system.partition_keys_all_v WHERE database_name='${sqlString(databaseName)}' AND table_name='${sqlString(tableName)}'`
  );
  if (!/^\d+$/.test(count)) throw new Error(`无法判断 ${databaseName}.${tableName} 是否为分区表，查询结果：${count || '空'}`);
  return Number(count) > 0;
}

function ensureLocalDirectory(dirPath, label) {
  if (!dirPath) throw new Error(`${label}不能为空`);
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`${label}不存在：${resolved}`);
  return resolved;
}

function ensureWritableRootDirectory(dirPath, label) {
  if (!dirPath) throw new Error(`${label}不能为空`);
  const resolved = path.resolve(dirPath);
  if (resolved === path.parse(resolved).root) throw new Error(`${label}不能是根目录：${resolved}`);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function listRegularFiles(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
  return fs.readdirSync(dirPath)
    .map((fileName) => path.join(dirPath, fileName))
    .filter((filePath) => fs.statSync(filePath).isFile());
}

function copyRegularFiles(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const files = listRegularFiles(sourceDir);
  for (const filePath of files) {
    const targetPath = path.join(targetDir, path.basename(filePath));
    fs.copyFileSync(filePath, targetPath);
  }
  return files.length;
}

function removeLocalDirInsideRoot(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error(`拒绝删除非预期目录：${target}`);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function runScriptSync(scriptName, args, options = {}) {
  const scriptPath = path.join(scriptDir, scriptName);
  if (!fs.existsSync(scriptPath)) throw new Error(`脚本不存在：${scriptPath}`);

  const result = spawnSync('bash', [scriptPath, ...args], {
    cwd: rootDir,
    encoding: 'utf8',
    env: { ...process.env, ...options.env }
  });
  if (result.status !== 0) {
    throw new Error(`${scriptName} 执行失败：${result.stderr || result.stdout || `退出码 ${result.status}`}`);
  }
  return result;
}

function getBeelineArgs(extraArgs = []) {
  if (!process.env.INCP_IP || !process.env.INCP_USER) {
    throw new Error('回查数据量需要设置 INCP_IP 和 INCP_USER');
  }
  const args = [
    '-u',
    `jdbc:hive2://${process.env.INCP_IP}:10000`,
    '-n',
    process.env.INCP_USER,
    '--silent=true',
    '--showHeader=false',
    '--outputformat=csv',
    ...extraArgs
  ];
  if (process.env.INCP_PASSWD) args.splice(4, 0, '-p', process.env.INCP_PASSWD);
  return args;
}

function kerberosLoginIfPossible() {
  const keytab = process.env.KRB_KEYTAB || '/home/tyf/etc/ekg.keytab';
  const principal = process.env.KRB_PRINCIPAL || 'ekg@TDH';
  if (fs.existsSync(keytab)) {
    const result = spawnSync('kinit', ['-kt', keytab, principal], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Kerberos 认证失败：${result.stderr || result.stdout}`);
  }
}

function runBeeline(extraArgs) {
  kerberosLoginIfPossible();
  const result = spawnSync('beeline', getBeelineArgs(extraArgs), { cwd: rootDir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`beeline 执行失败：${result.stderr || result.stdout}`);
  return result.stdout;
}

async function runBeelineAsync(extraArgs, options = {}) {
  kerberosLoginIfPossible();
  const result = await runCommandAsync('beeline', getBeelineArgs(extraArgs), options);
  return result.stdout;
}

function cleanBeelineLine(line) {
  return String(line || '')
    .trim()
    .replace(/\r/g, '')
    .replace(/^"|"$/g, '')
    .replace(/""/g, '"');
}

function sqlString(value) {
  return String(value ?? '').replace(/'/g, "''");
}

function listDatabaseTables(databaseName) {
  validateIdentifier(databaseName, '库名');
  const command = process.env.HIVE_LIST_TABLES_COMMAND;
  if (command) {
    const result = spawnSync(command.replace(/\{db\}/g, databaseName), {
      encoding: 'utf8',
      shell: true
    });
    if (result.status === 0) {
      return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
  }

  if (isExecutionEnabled()) {
    const output = runBeeline(['-e', `SHOW TABLES IN ${databaseName}`]);
    return output
      .split(/\r?\n/)
      .map(cleanBeelineLine)
      .filter((line) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(line));
  }

  return ['orders_detail', 'customer_profile', 'trade_partition_daily'];
}

function parseTaskConfig(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line, index) => {
      const parts = line.replace(/\|/g, ' ').split(/\s+/);
      if (parts.length === 5) {
        return makeRow({
          id: `view-${index + 1}`,
          viewName: parts[0],
          databaseName: parts[1],
          tableName: parts[2],
          startDate: parts[3],
          endDate: parts[4]
        });
      }
      return makeRow({
        id: `task-${index + 1}`,
        databaseName: parts[0],
        tableName: parts[1],
        startDate: parts[2],
        endDate: parts[3]
      });
    });
}

function fallbackResolveView(viewName) {
  const mapPath = process.env.VIEW_SOURCE_MAP_JSON || path.join(rootDir, 'view-source-map.json');
  if (fs.existsSync(mapPath)) {
    const mapped = JSON.parse(fs.readFileSync(mapPath, 'utf8'))[viewName];
    if (mapped) return Array.isArray(mapped) ? mapped : [mapped];
  }
  const clean = String(viewName || '').replace(/^v_/i, '').replace(/^view_/i, '');
  const parts = clean.includes('.') ? clean.split('.', 2) : ['prodb_dm', clean || 'unknown_table'];
  return [{ databaseName: parts[0], tableName: parts[1] }];
}

function normalizeViewName(viewName) {
  const viewDatabase = String(process.env.VIEW_DATABASE || 'fdm').toLowerCase();
  validateIdentifier(viewDatabase, '视图库名');
  const normalized = String(viewName || '').trim().toLowerCase();
  const fullName = normalized.includes('.') ? normalized : `${viewDatabase}.${normalized}`;
  const [databaseName, tableName] = fullName.split('.', 2);
  validateIdentifier(databaseName, '视图库名');
  validateIdentifier(tableName, '视图名');
  if (databaseName !== viewDatabase) throw new Error(`仅允许查询 ${viewDatabase} 库中的视图，收到：${fullName}`);
  return fullName;
}

function stripSqlForTableExtraction(sql) {
  return String(sql || '')
    .replace(/\r/g, '')
    .replace(/^"|"$/g, '')
    .replace(/""/g, '"')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:''|[^'])*'/g, ' ');
}

function extractBaseTablesFromSql(sql, rootView) {
  const cleaned = stripSqlForTableExtraction(sql);
  const root = String(rootView || '').toLowerCase();
  const seen = new Set();
  const tables = [];
  const pattern = /\b(?:from|join)\s+`?([a-z_][a-z0-9_]*)`?\s*\.\s*`?([a-z_][a-z0-9_]*)`?/gi;
  let match = pattern.exec(cleaned);
  while (match) {
    const databaseName = match[1].toLowerCase();
    const tableName = match[2].toLowerCase();
    const key = `${databaseName}.${tableName}`;
    if (key !== root && !seen.has(key)) {
      seen.add(key);
      tables.push({ databaseName, tableName });
    }
    match = pattern.exec(cleaned);
  }
  return tables;
}

function queryViewOriginText(viewName) {
  const [databaseName, tableName] = viewName.split('.', 2);
  const output = runBeeline(['-e',
    `SELECT origin_text FROM system.views_v WHERE database_name='${sqlString(databaseName)}' AND view_name='${sqlString(tableName)}' LIMIT 1`
  ]);
  const originText = cleanBeelineLine(output.trim());
  if (!originText) throw new Error(`system.views_v 中未找到视图或 origin_text 为空：${viewName}`);
  return originText;
}

function expandViewSourcesNative(rootView, currentView, visited = new Set()) {
  if (visited.has(currentView)) throw new Error(`检测到视图循环依赖：${[...visited, currentView].join('|')}`);
  visited.add(currentView);

  const viewDatabase = String(process.env.VIEW_DATABASE || 'fdm').toLowerCase();
  const originText = queryViewOriginText(currentView);
  const sourceTables = extractBaseTablesFromSql(originText, currentView);
  const rows = [];
  for (const source of sourceTables) {
    if (source.databaseName === viewDatabase) {
      rows.push(...expandViewSourcesNative(rootView, `${source.databaseName}.${source.tableName}`, new Set(visited)));
    } else {
      rows.push(source);
    }
  }
  return rows;
}

function buildRowsFromViewNative(items, fields, inputPath) {
  const rows = [];
  const recoverLines = [];
  const seen = new Set();

  items.forEach((item, index) => {
    if (!item.viewName) return;
    const viewName = normalizeViewName(item.viewName);
    const startDate = normalizeDate(item.startDate, fields.startDate);
    const endDate = normalizeDate(item.endDate, fields.endDate);
    validateDateRange({ startDate, endDate });
    const sources = expandViewSourcesNative(viewName, viewName);
    for (const source of sources) {
      const key = `${viewName}|${source.databaseName}|${source.tableName}|${startDate}|${endDate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(makeRow({
        id: `view-${index + 1}-${rows.length + 1}`,
        viewName,
        databaseName: source.databaseName,
        tableName: source.tableName,
        startDate,
        endDate
      }));
      recoverLines.push(`${source.databaseName}.${source.tableName} ${startDate.replace(/-/g, '')}-${endDate.replace(/-/g, '')}`);
    }
  });

  if (!rows.length) throw new Error('Node 后端未解析到视图源表');
  const configPath = writeTaskConfig(rows, 'view');
  fs.writeFileSync(path.join(path.dirname(configPath), 'prod_data_recover.txt'), `${[...new Set(recoverLines)].sort().join('\n')}\n`);
  return { rows, configPath, viewInputPath: inputPath };
}

function buildRowsFromViewScript(items, fields) {
  const stamp = Date.now();
  const inputPath = path.join(generatedDir, `views-${stamp}.txt`);
  const outputPath = path.join(generatedDir, `view-source-tables-${stamp}.txt`);
  const input = items
    .filter((item) => item.viewName)
    .map((item) => [
      item.viewName,
      normalizeDate(item.startDate, fields.startDate),
      normalizeDate(item.endDate, fields.endDate)
    ].join(' '))
    .join('\n');
  fs.writeFileSync(inputPath, `${input}\n`);

  if (isExecutionEnabled()) {
    try {
      return buildRowsFromViewNative(items, fields, inputPath);
    } catch (nativeError) {
      runScriptSync('view_to_source_tables.sh', [inputPath, outputPath]);
      const rows = parseTaskConfig(outputPath);
      if (!rows.length) throw new Error(`Node 视图解析失败：${nativeError.message}；脚本也未输出源表`);
      return {
        rows,
        configPath: outputPath,
        viewInputPath: inputPath,
        fallbackReason: `Node 视图解析失败，已回退 shell：${nativeError.message}`
      };
    }
  }

  const rows = items.flatMap((item, index) => {
    const viewName = item.viewName;
    if (!viewName) return [];
    return fallbackResolveView(viewName).map((source, sourceIndex) => makeRow({
      id: `view-${index + 1}-${sourceIndex + 1}`,
      viewName,
      databaseName: source.databaseName,
      tableName: source.tableName,
      startDate: normalizeDate(item.startDate, fields.startDate),
      endDate: normalizeDate(item.endDate, fields.endDate)
    }));
  });
  const configPath = writeTaskConfig(rows, 'view');
  return { rows, configPath, viewInputPath: inputPath };
}

function buildRows(fields, file) {
  const start = fields.startDate;
  const end = fields.endDate;
  if (fields.mode === 'full') {
    if (!fields.database) throw new Error('请输入库名');
    const rows = listDatabaseTables(fields.database).map((tableName, index) => makeRow({
      id: `full-${index + 1}`,
      databaseName: fields.database,
      tableName,
      startDate: start,
      endDate: end
    }));
    return { rows, configPath: writeTaskConfig(rows, 'full') };
  }

  const items = readTabularFile(file);
  if (!items.length) throw new Error('清单为空或无法识别表头');

  if (fields.mode === 'view') {
    return buildRowsFromViewScript(items, fields);
  }

  const rows = items.map((item, index) => makeRow({
    id: `${fields.mode === 'package' ? 'package' : 'source'}-${index + 1}`,
    databaseName: item.databaseName,
    tableName: item.tableName,
    startDate: normalizeDate(item.startDate, start),
    endDate: normalizeDate(item.endDate, end)
  })).filter((row) => row.tableName);
  return { rows, configPath: writeTaskConfig(rows, fields.mode === 'package' ? 'package' : 'source') };
}

function makeRow(row) {
  return {
    viewName: '',
    progress: 0,
    status: 'pending',
    statusText: statusText.pending,
    ...row
  };
}

function rowToConfigLine(row, options = {}) {
  const databaseName = options.preferRowDatabase
    ? (row.databaseName || options.targetDatabase || '')
    : (options.targetDatabase || row.databaseName || '');
  const fields = row.viewName
    ? [row.viewName, databaseName, row.tableName, row.startDate, row.endDate]
    : [databaseName, row.tableName, row.startDate, row.endDate];
  return fields.join('|');
}

function writeTaskConfig(rows, mode, options = {}) {
  const configPath = path.join(generatedDir, `recovery-${mode}-${Date.now()}.conf`);
  const body = rows.map((row) => rowToConfigLine(row, options)).join('\n');
  fs.writeFileSync(configPath, `${body}\n`);
  return configPath;
}

function isDryRun(restoreMode) {
  return !isExecutionEnabled();
}

function getDryRunReason(restoreMode) {
  if (!isExecutionEnabled()) return '未开启 RECOVERY_EXECUTE=1，进入 dry-run 流程。';
  return '已开启真实 Node 后端执行。';
}

function sendJob(job, payload = {}) {
  const data = JSON.stringify({
    id: job.id,
    status: job.status,
    rows: job.rows,
    logs: job.logs.slice(-80),
    summary: zeroCountSummary(job.summary || []),
    summaryTotal: job.summary?.length || 0,
    summaryZeroTotal: zeroCountSummary(job.summary || []).length,
    summaryFile: job.summaryFile ? { fileName: job.summaryFile.fileName, url: job.summaryFile.url } : null,
    ...payload
  });
  for (const subscriber of job.subscribers) subscriber.write(`data: ${data}\n\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createProgressHeartbeat(job, rows, label, options = {}) {
  const intervalMs = options.intervalMs || 12000;
  const maxProgress = options.maxProgress || 88;
  const step = options.step || 1;
  const targetRows = rows?.length ? rows : job.rows;
  let tick = 0;
  return setInterval(() => {
    tick += 1;
    for (const row of targetRows) {
      if (row.status === 'completed' || row.status === 'failed') continue;
      row.status = 'running';
      row.statusText = label;
      row.progress = Math.min(maxProgress, Math.max(row.progress || 0, 35) + step);
    }
    job.logs.push(`${label}，已持续 ${Math.round((tick * intervalMs) / 1000)} 秒，请等待 HDFS/Hive 命令返回。`);
    sendJob(job);
  }, intervalMs);
}

async function runWithProgressHeartbeat(job, rows, label, maxProgress, work) {
  const heartbeat = createProgressHeartbeat(job, rows, label, { maxProgress });
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
  }
}

function isRetryableHdfsPutError(error) {
  return /LeaseExpiredException|No lease|_COPYING_|AlreadyBeingCreatedException|could only be replicated|DataStreamer Exception/i
    .test(String(error?.message || error || ''));
}

async function runHdfsPutWithRetry(job, row, putArgs, cleanupArgs, label, maxProgress = 88) {
  const maxAttempts = Number(process.env.HDFS_PUT_RETRY_COUNT || 3);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 1) {
        job.logs.push(`${label} 第 ${attempt}/${maxAttempts} 次重试。`);
        sendJob(job);
      }
      await runWithProgressHeartbeat(job, [row], label, maxProgress, () => (
        runHdfsCommandAsync(putArgs, { onData: (chunk) => appendLog(job, chunk) })
      ));
      return;
    } catch (error) {
      if (!isRetryableHdfsPutError(error) || attempt >= maxAttempts) throw error;
      job.logs.push(`${label} 遇到 HDFS 临时写入/租约异常，清理目标后重试：${error.message}`);
      try {
        await runHdfsCommandAsync(cleanupArgs, { allowFailure: true, onData: (chunk) => appendLog(job, chunk) });
      } catch (cleanupError) {
        job.logs.push(`重试前清理目标失败，将继续重试：${cleanupError.message}`);
      }
      await sleep(1500 * attempt);
    }
  }
}

async function runHdfsBatchPutThenPartitionFallback(job, row, localPartitionDirs, hdfsPartitionDirs, tableRoot) {
  try {
    job.logs.push(`优先批量上传 ${localPartitionDirs.length} 个分区目录 -> ${tableRoot}/`);
    await runWithProgressHeartbeat(job, [row], '批量上传 HDFS 分区中', 88, () => (
      runHdfsCommandAsync(['-put', '-f', ...localPartitionDirs, `${tableRoot}/`], { onData: (chunk) => appendLog(job, chunk) })
    ));
    return;
  } catch (error) {
    job.logs.push(`批量上传 HDFS 分区失败，切换为逐日期分区上传：${error.message}`);
    sendJob(job);
  }

  for (let index = 0; index < localPartitionDirs.length; index += 1) {
    const localPartitionDir = localPartitionDirs[index];
    const hdfsPartitionDir = hdfsPartitionDirs[index];
    row.statusText = `上传 HDFS 分区 ${index + 1}/${localPartitionDirs.length}`;
    row.progress = Math.min(88, Math.max(row.progress || 0, 52 + Math.round((index / localPartitionDirs.length) * 30)));
    sendJob(job);
    await runHdfsPutWithRetry(
      job,
      row,
      ['-put', '-f', localPartitionDir, `${tableRoot}/`],
      ['-rm', '-r', '-f', hdfsPartitionDir],
      `上传分区 ${path.basename(localPartitionDir)}`,
      88
    );
    row.progress = Math.min(90, 58 + Math.round(((index + 1) / localPartitionDirs.length) * 30));
    sendJob(job);
  }
}

function appendLog(job, chunk) {
  const text = chunk.toString('utf8');
  for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    job.logs.push(line);
    updateRowsFromScriptLine(job, line);
  }
  sendJob(job);
}

function updateRowsFromScriptLine(job, line) {
  const lineNo = Number(/配置文件第\s+(\d+)\s+行/.exec(line)?.[1] || /视图列表第\s+(\d+)\s+行/.exec(line)?.[1]);
  if (!lineNo || !job.rows[lineNo - 1]) return;
  const row = job.rows[lineNo - 1];
  if (line.includes('处理成功')) {
    row.progress = 92;
    row.status = 'running';
    row.statusText = '待回查';
  } else if (line.includes('处理失败') || line.includes('错误')) {
    row.progress = Math.max(row.progress || 0, 30);
    row.status = 'failed';
    row.statusText = statusText.failed;
  } else {
    row.progress = Math.max(row.progress || 0, 35);
    row.status = 'running';
    row.statusText = statusText.running;
  }
}

function getRestoreArgs(restoreMode, configPath, options) {
  const scriptPath = path.join(scriptDir, scriptMap[restoreMode]);
  const sourceLabel = options.sourceType === 'unmasked' ? '未脱敏数据恢复源路径' : '脱敏数据恢复源路径';
  if (restoreMode === 'continuous') {
    if (!options.sourceRoot) throw new Error(`连续时间段恢复缺少${sourceLabel}，请设置 .env 或 config/recovery.local.json 中对应的源路径`);
    if (!options.stageRoot) throw new Error('连续时间段恢复缺少中转目录配置，请设置 .env 中的 RECOVERY_STAGE_ROOT 或 config/recovery.local.json 的 stageRoot');
    return [scriptPath, options.sourceRoot, options.stageRoot, configPath];
  }
  if (restoreMode === 'single') {
    if (!options.sourceRoot) throw new Error(`单日期恢复缺少${sourceLabel}，请设置 .env 或 config/recovery.local.json 中对应的源路径`);
    if (!options.nonPartitionSourceRoot) throw new Error('单日期恢复缺少非分区表恢复源路径，请设置 .env 中的 RECOVERY_NON_PARTITION_SOURCE_ROOT 或 config/recovery.local.json 的 nonPartitionSourceRoot');
    return [scriptPath, options.sourceRoot, configPath, options.nonPartitionSourceRoot];
  }
  if (restoreMode === 'cross') return [scriptPath, configPath];
  throw new Error(`未知恢复方式：${restoreMode}`);
}

async function executeRestoreScript(job, restoreMode, configPath, options) {
  const args = getRestoreArgs(restoreMode, configPath, options);
  await new Promise((resolve, reject) => {
    const child = spawn('bash', args, { cwd: rootDir, env: process.env });
    const heartbeat = createProgressHeartbeat(job, job.rows, 'shell 备用方案执行中', {
      maxProgress: 88,
      intervalMs: 10000
    });
    child.stdout.on('data', (chunk) => appendLog(job, chunk));
    child.stderr.on('data', (chunk) => appendLog(job, chunk));
    child.on('error', (error) => {
      clearInterval(heartbeat);
      reject(error);
    });
    child.on('exit', (code) => {
      clearInterval(heartbeat);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(args[0])} 退出码 ${code}`));
    });
  });
}

function markRowProgress(job, row, progress, text = statusText.running) {
  row.status = 'running';
  row.statusText = text;
  row.progress = Math.max(row.progress || 0, progress);
  sendJob(job);
}

function effectiveCrossRows(rows, targetDatabase) {
  return rows.map((row) => ({
    ...row,
    databaseName: row.databaseName || targetDatabase || ''
  }));
}

function buildTableMetadata(rows) {
  const partitionedTables = queryPartitionedTables(rows);
  const tableLocations = getTableLocations(rows);
  return { partitionedTables, tableLocations };
}

function getMetadataLocation(metadata, row, databaseName = row.databaseName) {
  const key = `${databaseName}.${row.tableName}`;
  const tablePath = metadata.tableLocations.get(key);
  if (!tablePath) throw new Error(`未查询到表 HDFS 路径：${key}`);
  validateHdfsTablePath(tablePath);
  return tablePath;
}

function copyLocalPartitionsToStage(row, sourceRoot, stageRoot, job) {
  const partitionColumn = getPartitionColumn();
  const preparedDates = [];
  const sourceBase = ensureLocalDirectory(sourceRoot, '本地源根目录');
  const stageBase = ensureWritableRootDirectory(stageRoot, '本地中转目录');
  const tableStageDir = path.join(stageBase, row.tableName);

  job.logs.push(`恢复开始前清理本表中转目录：${tableStageDir}`);
  removeLocalDirInsideRoot(stageBase, tableStageDir);

  for (const statDate of enumerateDates(row.startDate, row.endDate)) {
    const sourcePartition = path.join(sourceBase, statDate, row.tableName, `${partitionColumn}=${statDate}`);
    const targetPartition = path.join(stageBase, row.tableName, `${partitionColumn}=${statDate}`);
    if (!fs.existsSync(sourcePartition) || !fs.statSync(sourcePartition).isDirectory()) {
      job.logs.push(`提示：源分区目录不存在，跳过：${sourcePartition}`);
      continue;
    }
    const copied = copyRegularFiles(sourcePartition, targetPartition);
    if (copied > 0) {
      preparedDates.push(statDate);
      job.logs.push(`已拷贝本地分区：${sourcePartition} -> ${targetPartition}`);
    } else {
      job.logs.push(`提示：源分区目录没有普通文件，跳过：${sourcePartition}`);
    }
  }
  return preparedDates;
}

async function hdfsReplacePartitionsFromLocal(row, tablePath, localPartitionDirs, hdfsPartitionDirs, job) {
  if (!localPartitionDirs.length) return;
  job.logs.push(`删除 ${hdfsPartitionDirs.length} 个旧 HDFS 分区目录`);
  await runWithProgressHeartbeat(job, [row], '删除旧 HDFS 分区中', 70, () => (
    runHdfsCommandAsync(['-rm', '-r', '-f', ...hdfsPartitionDirs], { onData: (chunk) => appendLog(job, chunk) })
  ));
  const tableRoot = tablePath.replace(/\/+$/, '');
  await runHdfsCommandAsync(['-mkdir', '-p', tableRoot], { onData: (chunk) => appendLog(job, chunk) });
  await runHdfsBatchPutThenPartitionFallback(job, row, localPartitionDirs, hdfsPartitionDirs, tableRoot);
  await runWithProgressHeartbeat(job, [row], '修复 Hive 分区中', 92, () => (
    runBeelineAsync(['-e', `USE ${row.databaseName};MSCK REPAIR TABLE ${row.tableName}`], { onData: (chunk) => appendLog(job, chunk) })
  ));
  job.logs.push(`${row.databaseName}.${row.tableName} 分区修复完成`);
}

async function executeContinuousNative(job, options) {
  const metadata = buildTableMetadata(job.rows);
  const partitionColumn = getPartitionColumn();
  for (let index = 0; index < job.rows.length; index += 1) {
    const row = job.rows[index];
    validateIdentifier(row.databaseName, '库名');
    validateIdentifier(row.tableName, '表名');
    validateDateRange(row);
    markRowProgress(job, row, 16, '复制到中转目录');

    const preparedDates = copyLocalPartitionsToStage(row, options.sourceRoot, options.stageRoot, job);
    if (!preparedDates.length) {
      job.logs.push(`提示：${row.databaseName}.${row.tableName} 没有找到可处理的源分区，跳过`);
      row.progress = 100;
      row.status = 'completed';
      row.statusText = statusText.completed;
      sendJob(job);
      continue;
    }

    const key = tableKey(row);
    if (!metadata.partitionedTables.has(key)) {
      job.logs.push(`提示：${key} 不是分区表，跳过 HDFS 上传和分区修复`);
      row.progress = 100;
      row.status = 'completed';
      row.statusText = statusText.completed;
      sendJob(job);
      continue;
    }

    markRowProgress(job, row, 52, '替换 HDFS 分区');
    const tablePath = getMetadataLocation(metadata, row);
    const localPartitionDirs = preparedDates.map((statDate) => path.join(path.resolve(options.stageRoot), row.tableName, `${partitionColumn}=${statDate}`));
    const hdfsPartitionDirs = preparedDates.map((statDate) => `${tablePath.replace(/\/+$/, '')}/${partitionColumn}=${statDate}`);
    await hdfsReplacePartitionsFromLocal(row, tablePath, localPartitionDirs, hdfsPartitionDirs, job);
    removeLocalDirInsideRoot(options.stageRoot, path.join(options.stageRoot, row.tableName));
    row.progress = Math.max(row.progress || 0, 92);
    row.statusText = '待回查';
    sendJob(job);
  }
}

function getValidLocalPartitionDirs(row, sourceRoot, job) {
  const partitionColumn = getPartitionColumn();
  const sourceBase = ensureLocalDirectory(sourceRoot, '分区表源根目录');
  const sourcePartitions = [];
  const hdfsDates = [];
  for (const statDate of enumerateDates(row.startDate, row.endDate)) {
    const sourcePartition = path.join(sourceBase, statDate, row.tableName, `${partitionColumn}=${statDate}`);
    const files = listRegularFiles(sourcePartition);
    if (!fs.existsSync(sourcePartition) || !fs.statSync(sourcePartition).isDirectory()) {
      job.logs.push(`警告：源分区目录不存在，跳过：${sourcePartition}`);
    } else if (!files.length) {
      job.logs.push(`警告：源分区目录没有普通文件，跳过：${sourcePartition}`);
    } else {
      sourcePartitions.push(sourcePartition);
      hdfsDates.push(statDate);
    }
  }
  return { sourcePartitions, hdfsDates };
}

async function executeSingleNative(job, options) {
  const metadata = buildTableMetadata(job.rows);
  const partitionColumn = getPartitionColumn();
  ensureLocalDirectory(options.sourceRoot, '分区表源根目录');
  ensureLocalDirectory(options.nonPartitionSourceRoot, '非分区表源根目录');

  for (const row of job.rows) {
    validateIdentifier(row.databaseName, '库名');
    validateIdentifier(row.tableName, '表名');
    validateDateRange(row);
    markRowProgress(job, row, 18, '查询表路径');

    const key = tableKey(row);
    const tablePath = getMetadataLocation(metadata, row);
    if (metadata.partitionedTables.has(key)) {
      const { sourcePartitions, hdfsDates } = getValidLocalPartitionDirs(row, options.sourceRoot, job);
      if (!sourcePartitions.length) {
        job.logs.push(`警告：${key} 没有可上传的有效分区，跳过`);
        row.progress = 100;
        row.status = 'completed';
        row.statusText = statusText.completed;
        sendJob(job);
        continue;
      }
      markRowProgress(job, row, 52, '上传分区数据');
      const hdfsPartitions = hdfsDates.map((statDate) => `${tablePath.replace(/\/+$/, '')}/${partitionColumn}=${statDate}`);
      await hdfsReplacePartitionsFromLocal(row, tablePath, sourcePartitions, hdfsPartitions, job);
    } else {
      const sourceTable = path.join(path.resolve(options.nonPartitionSourceRoot), row.tableName);
      const sourceFiles = listRegularFiles(sourceTable);
      if (!sourceFiles.length) {
        job.logs.push(`警告：非分区表源目录不存在或没有普通文件，跳过：${sourceTable}`);
        row.progress = 100;
        row.status = 'completed';
        row.statusText = statusText.completed;
        sendJob(job);
        continue;
      }
      markRowProgress(job, row, 52, '上传非分区表数据');
      job.logs.push(`删除非分区表旧 HDFS 数据：${tablePath.replace(/\/+$/, '')}/*`);
      await runWithProgressHeartbeat(job, [row], '删除非分区表旧数据中', 70, () => (
        runHdfsCommandAsync(['-rm', '-r', '-f', `${tablePath.replace(/\/+$/, '')}/*`], { onData: (chunk) => appendLog(job, chunk) })
      ));
      const tableRoot = tablePath.replace(/\/+$/, '');
      await runHdfsCommandAsync(['-mkdir', '-p', tableRoot], { onData: (chunk) => appendLog(job, chunk) });
      await runHdfsPutWithRetry(
        job,
        row,
        ['-put', '-f', ...sourceFiles, `${tableRoot}/`],
        ['-rm', '-r', '-f', `${tableRoot}/*`],
        '上传非分区表数据中',
        88
      );
      job.logs.push(`${key} 非分区表数据上传完成`);
    }
    row.progress = Math.max(row.progress || 0, 92);
    row.statusText = '待回查';
    sendJob(job);
  }
}

async function executeCrossNative(job) {
  const sourceDatabase = getSourceDatabase();
  const partitionColumn = getPartitionColumn();
  const targetRows = job.rows;
  const sourceRows = targetRows.map((row) => ({ ...row, databaseName: sourceDatabase }));
  const sourceMetadata = buildTableMetadata(sourceRows);
  const targetMetadata = buildTableMetadata(targetRows);

  for (const row of targetRows) {
    validateIdentifier(row.databaseName, '目标库名');
    validateIdentifier(row.tableName, '表名');
    validateDateRange(row);
    if (row.databaseName === sourceDatabase) throw new Error(`目标库与源库相同，拒绝覆盖源表：${sourceDatabase}.${row.tableName}`);
    markRowProgress(job, row, 18, '准备跨库分区');

    const sourceKey = `${sourceDatabase}.${row.tableName}`;
    const targetKey = tableKey(row);
    if (!sourceMetadata.partitionedTables.has(sourceKey)) throw new Error(`${sourceKey} 不是分区表，无法跨库按日期复制`);
    if (!targetMetadata.partitionedTables.has(targetKey)) throw new Error(`${targetKey} 不是分区表，无法跨库按日期复制`);

    const sourceTablePath = sourceMetadata.tableLocations.get(sourceKey);
    const targetTablePath = targetMetadata.tableLocations.get(targetKey);
    if (!sourceTablePath || !targetTablePath) throw new Error(`未查询到跨库表路径：${sourceKey} -> ${targetKey}`);
    validateHdfsTablePath(sourceTablePath);
    validateHdfsTablePath(targetTablePath);
    if (sourceTablePath === targetTablePath) throw new Error(`源表和目标表 HDFS 路径相同，拒绝执行：${sourceTablePath}`);

    const sourcePartitions = [];
    const targetPartitions = [];
    for (const statDate of enumerateDates(row.startDate, row.endDate)) {
      const sourcePartition = `${sourceTablePath.replace(/\/+$/, '')}/${partitionColumn}=${statDate}`;
      const targetPartition = `${targetTablePath.replace(/\/+$/, '')}/${partitionColumn}=${statDate}`;
      if (hdfsTestDir(sourcePartition)) {
        sourcePartitions.push(sourcePartition);
        targetPartitions.push(targetPartition);
      } else {
        job.logs.push(`警告：源分区目录不存在，跳过日期 ${statDate}：${sourcePartition}`);
      }
    }

    if (!sourcePartitions.length) {
      job.logs.push(`警告：${sourceKey} 在指定日期范围内没有可复制的源分区，跳过`);
      row.progress = 100;
      row.status = 'completed';
      row.statusText = statusText.completed;
      sendJob(job);
      continue;
    }

    markRowProgress(job, row, 52, '复制跨库分区');
    await runWithProgressHeartbeat(job, [row], '删除目标 HDFS 分区中', 70, () => (
      runHdfsCommandAsync(['-rm', '-r', '-f', ...targetPartitions], { onData: (chunk) => appendLog(job, chunk) })
    ));
    await runHdfsCommandAsync(['-mkdir', '-p', ...targetPartitions], { onData: (chunk) => appendLog(job, chunk) });
    for (let index = 0; index < sourcePartitions.length; index += 1) {
      job.logs.push(`复制分区数据：${sourcePartitions[index]} -> ${targetPartitions[index]}/`);
      await runWithProgressHeartbeat(job, [row], `复制跨库分区 ${index + 1}/${sourcePartitions.length}`, 88, async () => {
        await runHdfsCommandAsync(['-cp', `${sourcePartitions[index].replace(/\/+$/, '')}/*`, `${targetPartitions[index].replace(/\/+$/, '')}/`], { onData: (chunk) => appendLog(job, chunk) });
        row.progress = Math.min(90, Math.round(52 + ((index + 1) / sourcePartitions.length) * 38));
        sendJob(job);
      });
    }
    await runWithProgressHeartbeat(job, [row], '修复 Hive 分区中', 92, () => (
      runBeelineAsync(['-e', `USE ${row.databaseName};MSCK REPAIR TABLE ${row.tableName}`], { onData: (chunk) => appendLog(job, chunk) })
    ));
    row.progress = Math.max(row.progress || 0, 92);
    row.statusText = '待回查';
    sendJob(job);
  }
}

async function executeRestoreNative(job, restoreMode, options) {
  if (restoreMode === 'continuous') return executeContinuousNative(job, options);
  if (restoreMode === 'single') return executeSingleNative(job, options);
  if (restoreMode === 'cross') return executeCrossNative(job, options);
  throw new Error(`未知恢复方式：${restoreMode}`);
}

async function executeRestoreNativeWithShellFallback(job, restoreMode, configPath, options) {
  try {
    job.logs.push('开始执行 Node 后端恢复逻辑。');
    sendJob(job);
    await executeRestoreNative(job, restoreMode, options);
    job.logs.push('Node 后端恢复逻辑执行完成。');
  } catch (nativeError) {
    job.logs.push(`Node 后端恢复失败，准备调用 shell 备用方案：${nativeError.message}`);
    sendJob(job);
    await executeRestoreScript(job, restoreMode, configPath, options);
    job.logs.push('shell 备用方案执行完成。');
  }
}

function fallbackCount(row) {
  const seed = `${row.databaseName}.${row.tableName}.${row.startDate}.${row.endDate}`;
  return [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) * 17;
}

function fallbackCountForDate(row, statDate) {
  const seed = `${row.databaseName}.${row.tableName}.${statDate}`;
  return [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) * 7;
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function enumerateDates(startDate, endDate) {
  const dates = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) return dates;
  let current = startDate;
  for (let guard = 0; guard < 3700 && current <= endDate; guard += 1) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

function makeSummaryItem(row, statDate, count, index) {
  return {
    id: `${row.id || `${row.databaseName}.${row.tableName}`}-${statDate}-${index}`,
    viewName: row.viewName || '',
    databaseName: row.databaseName || '',
    tableName: row.tableName || '',
    statDate,
    count: Number.isFinite(Number(count)) ? Number(count) : 0
  };
}

function zeroCountSummary(summary) {
  return summary.filter((item) => Number(item.count) === 0);
}

function writeCountSummaryWorkbook(job) {
  const fileName = `count-summary-${job.id}.xlsx`;
  const filePath = path.join(generatedDir, fileName);
  fs.writeFileSync(filePath, makeCountSummaryXlsx(job.summary));
  job.summaryFile = {
    fileName,
    filePath,
    url: `/api/jobs/${job.id}/count-summary.xlsx`
  };
}

function buildTablePredicate(rows) {
  const pairs = new Set(rows.map((row) => `${row.databaseName}.${row.tableName}`));
  return [...pairs].map((pair) => {
    const [databaseName, tableName] = pair.split('.', 2);
    validateIdentifier(databaseName, '库名');
    validateIdentifier(tableName, '表名');
    return `(database_name='${sqlString(databaseName)}' AND table_name='${sqlString(tableName)}')`;
  }).join(' OR ');
}

function queryPartitionedTables(rows) {
  const predicate = buildTablePredicate(rows);
  if (!predicate) return new Set();
  const sql = [
    "SELECT concat(database_name,'.',table_name,'|',cast(count(1) as string))",
    'FROM system.partition_keys_all_v',
    `WHERE ${predicate}`,
    'GROUP BY database_name,table_name'
  ].join(' ');
  const output = runBeeline(['-e', sql]);
  const partitioned = new Set();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = cleanBeelineLine(rawLine);
    const [tableKey, count] = line.split('|');
    if (tableKey && Number(count) > 0) partitioned.add(tableKey);
  }
  return partitioned;
}

function getTableLocations(rows) {
  const predicate = buildTablePredicate(rows);
  if (!predicate) return new Map();
  const locationColumn = process.env.TABLE_LOCATION_COLUMN || 'table_location';
  validateIdentifier(locationColumn, '表路径字段名');
  const sql = [
    `SELECT concat(database_name,'.',table_name,'|',${locationColumn})`,
    'FROM system.tables_v',
    `WHERE ${predicate}`
  ].join(' ');
  const output = runBeeline(['-e', sql]);
  const locations = new Map();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = cleanBeelineLine(rawLine);
    const separator = line.indexOf('|');
    if (separator <= 0) continue;
    const tableKey = line.slice(0, separator);
    const tableLocation = line.slice(separator + 1);
    if (tableKey && tableLocation) locations.set(tableKey, tableLocation);
  }
  return locations;
}

function ensureInsideRoot(rootPath, targetPath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`本地打包目录不合法：${resolvedTarget}`);
  }
}

function runHdfsGet(sourcePath, localTargetPath, packageRoot) {
  ensureInsideRoot(packageRoot, localTargetPath);
  fs.mkdirSync(path.dirname(localTargetPath), { recursive: true });
  if (fs.existsSync(localTargetPath)) fs.rmSync(localTargetPath, { recursive: true, force: true });
  runHdfsCommand(['-get', sourcePath, localTargetPath]);
}

function buildPackageCopies(row, options) {
  const tableKey = `${row.databaseName}.${row.tableName}`;
  const tableLocation = options.tableLocations.get(tableKey);
  if (!tableLocation) throw new Error(`未查询到表 HDFS 路径：${tableKey}`);

  const partitionColumn = process.env.PARTITION_COLUMN || 'tx_dt';
  validateIdentifier(partitionColumn, '分区字段名');
  if (!options.partitionedTables.has(tableKey)) {
    return [{
      statDate: 'ALL',
      sourcePath: tableLocation,
      localTargetPath: path.join(options.packageRoot, row.databaseName, row.tableName, 'ALL')
    }];
  }

  const dates = enumerateDates(row.startDate, row.endDate);
  if (!dates.length) throw new Error(`日期范围不合法：${row.startDate} 至 ${row.endDate}`);
  return dates.map((statDate) => ({
    statDate,
    sourcePath: `${tableLocation.replace(/\/+$/, '')}/${partitionColumn}=${statDate}`,
    localTargetPath: path.join(options.packageRoot, row.databaseName, row.tableName, `${partitionColumn}=${statDate}`)
  }));
}

function parseDirectCountOutput(output, rows, partitionedTables) {
  const byIndexAndDate = new Map();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = cleanBeelineLine(rawLine);
    if (!line.startsWith('__COUNT__|')) continue;
    const [, rowIndex, statDate, countText] = line.split('|');
    const count = Number(countText);
    byIndexAndDate.set(`${rowIndex}|${statDate}`, Number.isFinite(count) ? count : 0);
  }

  return rows.flatMap((row, index) => {
    const rowIndex = String(index + 1);
    const tableKey = `${row.databaseName}.${row.tableName}`;
    if (!partitionedTables.has(tableKey)) {
      return [makeSummaryItem(row, 'ALL', byIndexAndDate.get(`${rowIndex}|ALL`) || 0, index)];
    }
    return enumerateDates(row.startDate, row.endDate).map((statDate, dateIndex) => (
      makeSummaryItem(row, statDate, byIndexAndDate.get(`${rowIndex}|${statDate}`) || 0, `${index}-${dateIndex}`)
    ));
  });
}

function parseCountScriptOutput(outputPath, rows) {
  if (!fs.existsSync(outputPath)) return [];
  const byIndex = new Map();
  const rowKeys = rows.map((row) => `${row.viewName || ''}|${row.databaseName}|${row.tableName}`);
  rows.forEach((row, index) => byIndex.set(rowKeys[index], { row, index }));

  const summary = [];
  const lines = fs.readFileSync(outputPath, 'utf8').split(/\r?\n/);
  lines.forEach((line, lineIndex) => {
    if (!line.trim()) return;
    const parts = line.split('|');
    let viewName = '';
    let databaseName = '';
    let tableName = '';
    let statDate = '';
    let countText = '';
    if (parts.length === 5) {
      [viewName, databaseName, tableName, statDate, countText] = parts;
    } else if (parts.length === 4) {
      [databaseName, tableName, statDate, countText] = parts;
    } else if (parts.length === 3) {
      [tableName, statDate, countText] = parts;
    }
    const key = `${viewName}|${databaseName}|${tableName}`;
    const matched = byIndex.get(key) || rows.map((row, index) => ({ row, index })).find((item) => item.row.tableName === tableName);
    const row = matched?.row || { id: `count-${lineIndex}`, viewName, databaseName, tableName };
    summary.push(makeSummaryItem(row, statDate || 'ALL', Number(countText), `${matched?.index ?? lineIndex}-${lineIndex}`));
  });
  return summary;
}

function queryCountsDirect(rows) {
  const partitionedTables = queryPartitionedTables(rows);
  const partitionColumn = process.env.PARTITION_COLUMN || 'tx_dt';
  validateIdentifier(partitionColumn, '分区字段名');

  const statements = rows.map((row, index) => {
    validateIdentifier(row.databaseName, '库名');
    validateIdentifier(row.tableName, '表名');
    const rowIndex = String(index + 1);
    const tableKey = `${row.databaseName}.${row.tableName}`;
    if (partitionedTables.has(tableKey)) {
      return [
        `SELECT concat('__COUNT__|${rowIndex}|',cast(${partitionColumn} as string),'|',cast(count(1) as string))`,
        `FROM ${row.databaseName}.${row.tableName}`,
        `WHERE ${partitionColumn}>='${sqlString(row.startDate)}' AND ${partitionColumn}<='${sqlString(row.endDate)}'`,
        `GROUP BY ${partitionColumn}`
      ].join(' ');
    }
    return [
      `SELECT concat('__COUNT__|${rowIndex}|ALL|',cast(count(1) as string))`,
      `FROM ${row.databaseName}.${row.tableName}`
    ].join(' ');
  });

  const sqlPath = path.join(generatedDir, `count-direct-${Date.now()}.sql`);
  fs.writeFileSync(sqlPath, `${statements.join(';\n')};\n`);
  const output = runBeeline(['-f', sqlPath]);
  return {
    sqlPath,
    summary: parseDirectCountOutput(output, rows, partitionedTables)
  };
}

async function queryCounts(job, configPath) {
  if (isExecutionEnabled()) {
    try {
      const result = queryCountsDirect(job.rows);
      job.summary = result.summary;
      writeCountSummaryWorkbook(job);
      job.logs.push(`Node 后端数据量批量回查完成：${result.sqlPath}`);
      return true;
    } catch (error) {
      job.logs.push(`Node 后端数据量回查失败：${error.message}`);
      if (fs.existsSync(path.join(scriptDir, 'count_table_rows.sh'))) {
        try {
          const outputPath = path.join(generatedDir, `count-result-${job.id}.txt`);
          runScriptSync('count_table_rows.sh', [configPath, outputPath]);
          job.summary = parseCountScriptOutput(outputPath, job.rows);
          writeCountSummaryWorkbook(job);
          job.logs.push(`shell 备用数据量回查完成：${outputPath}`);
          return true;
        } catch (fallbackError) {
          job.summary = [];
          job.logs.push(`shell 备用数据量回查失败：${fallbackError.message}`);
          return false;
        }
      }
      job.summary = [];
      return false;
    }
  }

  job.summary = job.rows.flatMap((row, index) => {
    const dates = enumerateDates(row.startDate, row.endDate);
    if (!dates.length) return [makeSummaryItem(row, 'ALL', fallbackCount(row), index)];
    return dates.map((statDate, dateIndex) => makeSummaryItem(row, statDate, fallbackCountForDate(row, statDate), `${index}-${dateIndex}`));
  });
  writeCountSummaryWorkbook(job);
  job.logs.push('dry-run 使用 Node 后端模拟分区数据量明细。');
  return true;
}

async function runJob(job, restoreMode, options) {
  const dryRun = isDryRun(restoreMode);
  if (restoreMode === 'cross') {
    job.rows = effectiveCrossRows(job.rows, options.targetDatabase);
  }
  const configPath = writeTaskConfig(job.rows, restoreMode, {
    targetDatabase: restoreMode === 'cross' ? options.targetDatabase : '',
    preferRowDatabase: restoreMode === 'cross'
  });
  job.configPath = configPath;
  job.logs.push(`任务配置文件：${configPath}`);
  if (restoreMode === 'continuous' || restoreMode === 'single') {
    job.logs.push(`恢复源类型：${options.sourceType === 'unmasked' ? '未脱敏数据' : '脱敏数据'}`);
  }
  job.logs.push(dryRun ? getDryRunReason(restoreMode) : '已开启真实 Node 后端执行，shell 脚本仅作为失败兜底。');
  sendJob(job);

  for (const row of job.rows) {
    row.status = 'running';
    row.statusText = statusText.running;
    row.progress = 8;
  }
  sendJob(job);

  try {
    if (dryRun) {
      for (const row of job.rows) {
        job.logs.push(`模拟恢复 ${row.databaseName}.${row.tableName} ${row.startDate} 至 ${row.endDate}`);
        for (const progress of [24, 46, 68, 88]) {
          await sleep(260);
          row.progress = progress;
          sendJob(job);
        }
      }
    } else {
      await executeRestoreNativeWithShellFallback(job, restoreMode, configPath, options);
    }
    for (const row of job.rows) {
      if (row.status !== 'failed') {
      row.progress = 100;
      row.status = 'completed';
      row.statusText = statusText.completed;
      }
    }
    const countSucceeded = await queryCounts(job, configPath);
    job.logs.push(countSucceeded ? '恢复执行完成，数据量已回查。' : '恢复执行完成，数据量回查失败，请查看日志。');
  } catch (error) {
    job.status = 'failed';
    job.logs.push(`恢复执行失败：${error.message}`);
    for (const row of job.rows) {
      if (row.status !== 'completed') {
        row.status = 'failed';
        row.statusText = statusText.failed;
      }
    }
  }

  job.status = job.rows.some((row) => row.status === 'failed') ? 'failed' : 'completed';
  job.logs.push(job.status === 'completed' ? '全部恢复任务完成。' : '恢复任务结束，存在失败行。');
  sendJob(job);
}

async function runPackageJob(job, options) {
  const dryRun = !isExecutionEnabled();
  const configPath = writeTaskConfig(job.rows, 'package');
  job.configPath = configPath;
  job.logs.push(`打包任务配置文件：${configPath}`);
  job.logs.push(`本地打包目录：${options.packageRoot}`);
  job.logs.push(dryRun ? '未开启 RECOVERY_EXECUTE=1，进入 dry-run 打包流程。' : '已开启真实 HDFS get 打包执行。');
  sendJob(job);

  for (const row of job.rows) {
    row.status = 'running';
    row.statusText = statusText.running;
    row.progress = 8;
  }
  sendJob(job);

  try {
    if (dryRun) {
      for (const row of job.rows) {
        const dates = enumerateDates(row.startDate, row.endDate);
        job.logs.push(`模拟打包 ${row.databaseName}.${row.tableName} ${row.startDate} 至 ${row.endDate}，目标目录 ${options.packageRoot}`);
        for (const progress of [26, 52, 78, 100]) {
          await sleep(220);
          row.progress = progress;
          sendJob(job);
        }
        row.status = 'completed';
        row.statusText = dates.length ? `已模拟 ${dates.length} 个日期` : statusText.completed;
      }
    } else {
      const partitionedTables = queryPartitionedTables(job.rows);
      const tableLocations = getTableLocations(job.rows);
      job.logs.push('已查询表分区信息和 HDFS 表路径。');
      sendJob(job);

      for (const row of job.rows) {
        row.status = 'running';
        row.statusText = '查询 HDFS 路径';
        row.progress = 12;
        sendJob(job);

        const copies = buildPackageCopies(row, {
          packageRoot: options.packageRoot,
          partitionedTables,
          tableLocations
        });
        row.statusText = `打包 ${copies.length} 个路径`;

        for (let index = 0; index < copies.length; index += 1) {
          const copy = copies[index];
          job.logs.push(`hdfs dfs -get ${copy.sourcePath} ${copy.localTargetPath}`);
          runHdfsGet(copy.sourcePath, copy.localTargetPath, options.packageRoot);
          row.progress = Math.min(96, Math.round(20 + ((index + 1) / copies.length) * 76));
          row.statusText = copy.statDate === 'ALL' ? '非分区表打包中' : `打包 ${copy.statDate}`;
          sendJob(job);
        }

        row.progress = 100;
        row.status = 'completed';
        row.statusText = statusText.completed;
        sendJob(job);
      }
    }

    job.logs.push('数据文件打包完成。');
  } catch (error) {
    job.status = 'failed';
    job.logs.push(`数据文件打包失败：${error.message}`);
    for (const row of job.rows) {
      if (row.status !== 'completed') {
        row.status = 'failed';
        row.statusText = statusText.failed;
      }
    }
  }

  job.status = job.rows.some((row) => row.status === 'failed') ? 'failed' : 'completed';
  job.logs.push(job.status === 'completed' ? '全部打包任务完成。' : '打包任务结束，存在失败行。');
  sendJob(job);
}

async function handleParse(req, res) {
  try {
    const body = await readBody(req);
    const { fields, files } = parseMultipart(body, req.headers['content-type']);
    const { rows, configPath, viewInputPath, fallbackReason } = buildRows(fields, files.file);
    sendJson(res, 200, {
      rows,
      meta: {
        configPath,
        viewInputPath,
        ...getExecutionMeta()
      },
      logs: [
        `已读取 ${rows.length} 个${fields.mode === 'package' ? '打包对象' : '恢复对象'}。`,
        fields.mode === 'view'
          ? '已根据视图名解析源表并生成恢复配置。'
          : fields.mode === 'package'
            ? '已生成数据文件打包配置。'
            : '已生成恢复配置。',
        ...(fallbackReason ? [fallbackReason] : [])
      ]
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleRestore(req, res) {
  try {
    const payload = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!Array.isArray(payload.rows) || !payload.rows.length) throw new Error('没有可恢复的行');
    if (payload.restoreMode === 'cross') {
      const missingTargetDatabaseRows = payload.rows.filter((row) => !row.databaseName);
      if (missingTargetDatabaseRows.length && !payload.targetDatabase) {
        throw new Error('跨库数据恢复中存在未填写库名的行，请在清单库名列补充目标库，或填写页面跨库目标库作为统一兜底');
      }
    } else if (payload.rows.some((row) => !row.databaseName)) {
      throw new Error('连续时间段恢复和单日期恢复要求清单中每行必须包含库名');
    }

    const jobId = `job-${Date.now()}`;
    const job = {
      id: jobId,
      status: 'running',
      rows: payload.rows.map((row) => makeRow({ ...row, progress: 0, status: 'pending' })),
      logs: [],
      summary: [],
      subscribers: new Set()
    };
    jobs.set(jobId, job);
    sendJson(res, 200, { jobId });
    const sourcePathConfig = resolveSourceRoot(payload.sourceType);
    runJob(job, payload.restoreMode, {
      targetDatabase: payload.targetDatabase,
      sourceRoot: sourcePathConfig.sourceRoot,
      sourceType: sourcePathConfig.sourceType,
      nonPartitionSourceRoot: sourcePathConfig.nonPartitionSourceRoot,
      stageRoot: sourcePathConfig.stageRoot
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handlePackage(req, res) {
  try {
    const payload = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!Array.isArray(payload.rows) || !payload.rows.length) throw new Error('没有可打包的行');
    if (payload.rows.some((row) => !row.databaseName || !row.tableName)) {
      throw new Error('数据文件打包要求每行必须包含库名和表名');
    }
    if (payload.rows.some((row) => !row.startDate || !row.endDate)) {
      throw new Error('数据文件打包要求每行必须包含开始日期和结束日期');
    }

    const localPathConfig = getLocalPathConfig();
    if (!localPathConfig.packageRoot) {
      throw new Error('数据文件打包缺少本地拷贝目录配置，请设置 DATA_PACKAGE_ROOT 或 config/recovery.local.json 的 packageRoot');
    }

    const jobId = `job-${Date.now()}`;
    const job = {
      id: jobId,
      status: 'running',
      rows: payload.rows.map((row) => makeRow({ ...row, progress: 0, status: 'pending' })),
      logs: [],
      summary: [],
      subscribers: new Set()
    };
    jobs.set(jobId, job);
    sendJson(res, 200, { jobId });
    runPackageJob(job, {
      packageRoot: localPathConfig.packageRoot
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function handleTemplateDownload(req, res) {
  const buffer = makeRecoveryTemplateXlsx();
  sendBuffer(res, 200, buffer, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': "attachment; filename=\"recovery-template.xlsx\"; filename*=UTF-8''%E6%81%A2%E5%A4%8D%E6%A8%A1%E7%89%88.xlsx",
    'Cache-Control': 'no-store'
  });
}

function handleCountSummaryDownload(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job?.summaryFile || !fs.existsSync(job.summaryFile.filePath)) {
    return sendJson(res, 404, { error: '数据量回查明细文件不存在或尚未生成' });
  }
  const buffer = fs.readFileSync(job.summaryFile.filePath);
  return sendBuffer(res, 200, buffer, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': "attachment; filename=\"count-summary.xlsx\"; filename*=UTF-8''%E6%95%B0%E6%8D%AE%E9%87%8F%E5%9B%9E%E6%9F%A5%E6%98%8E%E7%BB%86.xlsx",
    'Cache-Control': 'no-store'
  });
}

function handleEvents(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    res.writeHead(404);
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  job.subscribers.add(res);
  sendJob(job);
  req.on('close', () => job.subscribers.delete(res));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/templates/recovery.xlsx') return handleTemplateDownload(req, res);
  if ((req.method === 'GET' || req.method === 'HEAD') && /^\/api\/jobs\/[^/]+\/count-summary\.xlsx$/.test(url.pathname)) {
    return handleCountSummaryDownload(req, res, url.pathname.split('/')[3]);
  }
  if (req.method === 'POST' && url.pathname === '/api/parse') return handleParse(req, res);
  if (req.method === 'POST' && url.pathname === '/api/restore') return handleRestore(req, res);
  if (req.method === 'POST' && url.pathname === '/api/package') return handlePackage(req, res);
  if (req.method === 'GET' && /^\/api\/jobs\/[^/]+\/events$/.test(url.pathname)) {
    return handleEvents(req, res, url.pathname.split('/')[3]);
  }

  return handleStatic(req, res, url);
});

const port = process.env.PORT || 3001;
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => {
  console.log(`Data recovery console listening on http://${host}:${port}`);
});
