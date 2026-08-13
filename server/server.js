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
let generatedSqlSequence = 0;
let jobSequence = 0;

/**
 * 方法说明：解析环境变量文本，去除首尾空白和包裹引号。
 * @param {*} value - 待处理的输入值。
 * @returns {*} - 方法执行结果。
 */
function parseEnvValue(value) {
  const trimmed = String(value || '').trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 方法说明：读取 .env 文件并将未定义的键加载到进程环境。
 * @param {*} filePath - 输入或输出文件路径。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：读取大于零的数值型环境变量，非法值回退到默认值。
 * @param {*} name - 环境变量名称。
 * @param {*} fallback - 默认数值。
 * @returns {*} - 可用于时长计算的正数。
 */
function readPositiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 方法说明：判断文件是否为需要提供下载的数据量或视图源表 Excel 结果。
 * @param {*} fileName - 文件名称。
 * @returns {*} - 是否为结果文件。
 */
function isDownloadResultFile(fileName) {
  return /^(count-summary|view-source-summary)-.+\.xlsx$/i.test(fileName);
}

/**
 * 方法说明：仅删除指定目录内的文件，避免清理逻辑越界删除其他路径。
 * @param {*} filePath - 待删除文件路径。
 * @param {*} allowedDir - 允许清理的根目录。
 * @returns {*} - 是否成功删除。
 */
function removeManagedFile(filePath, allowedDir) {
  if (!filePath) return false;
  const resolvedPath = path.resolve(filePath);
  const resolvedDir = `${path.resolve(allowedDir)}${path.sep}`;
  if (!resolvedPath.startsWith(resolvedDir) || !fs.existsSync(resolvedPath)) return false;
  try {
    fs.unlinkSync(resolvedPath);
    return true;
  } catch (error) {
    console.warn(`清理文件失败：${resolvedPath}，${error.message}`);
    return false;
  }
}

/**
 * 方法说明：收集执行中任务正在使用的配置和结果文件，防止定时清理误删。
 * @returns {*} - 受保护文件绝对路径集合。
 */
function getActiveArtifactPaths() {
  const protectedPaths = new Set();
  for (const job of jobs.values()) {
    if (!['completed', 'failed', 'canceled'].includes(job.status)) {
      if (job.configPath) protectedPaths.add(path.resolve(job.configPath));
      if (job.summaryFile?.filePath) protectedPaths.add(path.resolve(job.summaryFile.filePath));
    }
  }
  return protectedPaths;
}

/**
 * 方法说明：按文件最后修改时间清理目录中的过期文件，并跳过执行中任务占用的文件。
 * @param {*} directory - 待清理目录。
 * @param {*} resolveRetentionMs - 根据文件名返回保留毫秒数的方法。
 * @param {*} protectedPaths - 受保护文件路径集合。
 * @returns {*} - 本次删除的文件数量。
 */
function cleanupDirectoryFiles(directory, resolveRetentionMs, protectedPaths = new Set()) {
  const now = Date.now();
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    console.warn(`读取清理目录失败：${directory}，${error.message}`);
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(directory, entry.name);
    if (protectedPaths.has(path.resolve(filePath))) continue;
    try {
      const retentionMs = resolveRetentionMs(entry.name);
      if (now - fs.statSync(filePath).mtimeMs >= retentionMs && removeManagedFile(filePath, directory)) removed += 1;
    } catch (error) {
      console.warn(`检查过期文件失败：${filePath}，${error.message}`);
    }
  }
  return removed;
}

/**
 * 方法说明：清理上传备份、生成目录中的过期中间文件和结果文件，并移除过期任务状态。
 * @returns {*} - 各类清理数量。
 */
function cleanupExpiredStorage() {
  const hourMs = 60 * 60 * 1000;
  const uploadRetentionMs = readPositiveNumberEnv('UPLOAD_FILE_RETENTION_HOURS', 1) * hourMs;
  const tempRetentionMs = readPositiveNumberEnv('TEMP_FILE_RETENTION_HOURS', 24) * hourMs;
  const resultRetentionMs = readPositiveNumberEnv('RESULT_FILE_RETENTION_HOURS', 168) * hourMs;
  const jobRetentionMs = readPositiveNumberEnv('JOB_RETENTION_HOURS', 168) * hourMs;
  const protectedPaths = getActiveArtifactPaths();
  const removedUploads = cleanupDirectoryFiles(uploadDir, () => uploadRetentionMs);
  const removedGenerated = cleanupDirectoryFiles(
    generatedDir,
    (fileName) => isDownloadResultFile(fileName) ? resultRetentionMs : tempRetentionMs,
    protectedPaths
  );
  let removedJobs = 0;
  const now = Date.now();
  for (const [jobId, job] of jobs) {
    if (!['completed', 'failed', 'canceled'].includes(job.status)) continue;
    const finishedAt = job.finishedAt || job.updatedAt || job.createdAt || now;
    if (now - finishedAt < jobRetentionMs) continue;
    for (const subscriber of job.subscribers) subscriber.end();
    jobs.delete(jobId);
    removedJobs += 1;
  }
  if (removedUploads || removedGenerated || removedJobs) {
    console.log(`临时存储清理完成：上传文件 ${removedUploads} 个，中间/结果文件 ${removedGenerated} 个，过期任务 ${removedJobs} 个。`);
  }
  return { removedUploads, removedGenerated, removedJobs };
}

/**
 * 方法说明：启动定时存储清理，并使用 unref 避免定时器阻止服务正常退出。
 * @returns {*} - 定时器对象。
 */
function scheduleStorageCleanup() {
  cleanupExpiredStorage();
  const intervalMinutes = readPositiveNumberEnv('TEMP_CLEANUP_INTERVAL_MINUTES', 30);
  const timer = setInterval(cleanupExpiredStorage, intervalMinutes * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

const scriptMap = {
  continuous: 'copy_hive_partitions.sh',
  single: 'file_to_prodb_optimized.sh',
  cross: 'prodb_dm_to_target_partitions.sh'
};

const statusText = {
  pending: '待执行',
  running: '执行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  canceled: '已终止'
};

/**
 * 方法说明：按优先级读取本地 JSON 恢复配置并解析为对象。
 * @returns {*} - 方法执行结果。
 */
function readLocalRecoveryConfig() {
  const localConfigPath = localConfigPaths.find((item) => fs.existsSync(item));
  if (!localConfigPath) return {};
  try {
    return JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
  } catch (error) {
    throw new Error(`本地恢复配置解析失败：${localConfigPath}，${error.message}`);
  }
}

/**
 * 方法说明：合并环境变量和本地配置，得到各类恢复目录。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：根据脱敏或未脱敏选项返回对应源目录及中转目录。
 * @param {*} sourceType - 恢复源类型。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：设置 JSON 响应头并向浏览器返回结构化结果。
 * @param {*} res - HTTP 响应对象。
 * @param {*} code - HTTP 状态码。
 * @param {*} payload - 待返回的 JSON 数据。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：计算文件或数据缓冲区的 CRC32 校验值。
 * @param {*} buffer - 数据缓冲区。
 * @returns {*} - 方法执行结果。
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 方法说明：将 JavaScript 日期转换为 ZIP 文件使用的 DOS 日期和时间。
 * @param {*} date - 方法输入的 date 参数。
 * @returns {*} - 方法执行结果。
 */
function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

/**
 * 方法说明：根据文件条目构造不依赖第三方库的 ZIP 文件。
 * @param {*} entries - 方法输入的 entries 参数。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：转义 XML 特殊字符，避免生成的工作簿 XML 无效。
 * @param {*} value - 待处理的输入值。
 * @returns {*} - 方法执行结果。
 */
function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 方法说明：将行列下标转换为 Excel 单元格引用。
 * @param {*} columnIndexValue - Excel 列下标。
 * @param {*} rowIndex - 当前行下标。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：根据二维数据生成 Excel 工作表 XML。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：将工作表名称和数据行封装为可下载的 XLSX 文件。
 * @param {*} sheetName - Excel 工作表名称。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：生成恢复清单上传模板。
 * @returns {*} - 方法执行结果。
 */
function makeRecoveryTemplateXlsx() {
  return makeSimpleXlsx('恢复清单模板', [
    ['视图名', '库名', '源表名', '数据恢复开始日期', '数据恢复结束日期'],
    ['', '', '', '', '']
  ]);
}

/**
 * 方法说明：生成包含日期分区数据量的回查结果 Excel。
 * @param {*} summary - 数据量统计结果数组。
 * @returns {*} - 方法执行结果。
 */
function makeCountSummaryXlsx(summary) {
  const rows = [
    ['视图名', '库名', '表名', '时间分区', '数据量', '查询状态', '查询错误'],
    ...summary.map((item) => [
      item.viewName || '',
      item.databaseName || '',
      item.tableName || '',
      item.statDate || '',
      item.count == null ? '' : String(item.count),
      item.queryStatus || '查询成功',
      item.queryError || ''
    ])
  ];
  return makeSimpleXlsx('数据量回查明细', rows);
}

/**
 * 方法说明：生成视图源表查询结果 Excel。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
function makeViewSourceSummaryXlsx(rows) {
  return makeSimpleXlsx('视图源表查询', [
    ['视图名', '源表库名', '源表名', '开始日期', '结束日期'],
    ...rows.map((row) => [
      row.viewName || '',
      row.databaseName || '',
      row.tableName || '',
      row.startDate || '',
      row.endDate || ''
    ])
  ]);
}

/**
 * 方法说明：读取本地文件并根据扩展名设置响应类型后返回。
 * @param {*} res - HTTP 响应对象。
 * @param {*} filePath - 输入或输出文件路径。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：处理前端静态资源请求并返回页面或资源文件。
 * @param {*} req - HTTP 请求对象。
 * @param {*} res - HTTP 响应对象。
 * @param {*} url - 方法输入的 url 参数。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：收集 HTTP 请求体数据并在请求结束后返回缓冲区。
 * @param {*} req - HTTP 请求对象。
 * @returns {*} - 方法执行结果。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 方法说明：解析上传请求中的文件和普通表单字段。
 * @param {*} buffer - 数据缓冲区。
 * @param {*} contentType - 上传请求的 Content-Type。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：还原 XML 实体字符为普通文本。
 * @param {*} value - 待处理的输入值。
 * @returns {*} - 方法执行结果。
 */
function xmlDecode(value = '') {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * 方法说明：从 ZIP 文件中读取指定条目内容。
 * @param {*} filePath - 输入或输出文件路径。
 * @param {*} entry - ZIP 文件条目。
 * @returns {*} - 方法执行结果。
 */
function unzipEntry(filePath, entry) {
  const result = spawnSync('unzip', ['-p', filePath, entry], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : '';
}

/**
 * 方法说明：解析 XLSX 共享字符串表。
 * @param {*} xml - XML 文本。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：将 Excel 列名转换为从零开始的列下标。
 * @param {*} cellRef - 方法输入的 cellRef 参数。
 * @returns {*} - 方法执行结果。
 */
function columnIndex(cellRef = '') {
  const letters = cellRef.replace(/[^A-Z]/g, '');
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, index - 1);
}

/**
 * 方法说明：将 Excel 数值日期转换为统一日期文本。
 * @param {*} value - 待处理的输入值。
 * @returns {*} - 方法执行结果。
 */
function excelSerialToDate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 20000 || number > 80000) return String(value || '');
  const utc = Math.round((number - 25569) * 86400 * 1000);
  return new Date(utc).toISOString().slice(0, 10);
}

/**
 * 方法说明：解析 XLSX 工作表 XML 为二维单元格数组。
 * @param {*} xml - XML 文本。
 * @param {*} sharedStrings - 方法输入的 sharedStrings 参数。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：读取 XLSX 压缩包并解析首个工作表。
 * @param {*} filePath - 输入或输出文件路径。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：按 CSV 引号规则解析文本表格。
 * @param {*} filePath - 输入或输出文件路径。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：将表格首行作为字段名并转换为对象数组。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：统一表头大小写、空白和同义字段名称。
 * @param {*} header - 方法输入的 header 参数。
 * @returns {*} - 方法执行结果。
 */
function normalizeHeader(header = '') {
  const value = String(header).trim().toLowerCase().replace(/[\s_-]+/g, '');
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
    '恢复开始日期': 'startDate',
    '数据开始日期': 'startDate',
    '开始日期': 'startDate',
    startdate: 'startDate',
    start: 'startDate',
    '数据恢复结束日期': 'endDate',
    '恢复结束日期': 'endDate',
    '数据结束日期': 'endDate',
    '结束日期': 'endDate',
    enddate: 'endDate',
    end: 'endDate'
  };
  return map[value] || value;
}

/**
 * 方法说明：根据文件扩展名读取 XLSX 或 CSV 清单。
 * @param {*} file - 上传文件对象。
 * @returns {*} - 方法执行结果。
 */
function readTabularFile(file) {
  if (!file) return [];
  const ext = path.extname(file.filename).toLowerCase();
  const rows = ext === '.csv' ? parseCsv(file.path) : parseXlsx(file.path);
  return rowsToObjects(rows);
}

/**
 * 方法说明：将年月日数字补零并校验为有效日期。
 * @param {*} year - 方法输入的 year 参数。
 * @param {*} month - 方法输入的 month 参数。
 * @param {*} day - 方法输入的 day 参数。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：兼容多种输入日期格式并统一为 YYYY-MM-DD。
 * @param {*} value - 待处理的输入值。
 * @param {*} fallback - 输入为空时使用的备用值。
 * @returns {*} - 方法执行结果。
 */
function normalizeDate(value, fallback) {
  const rawValue = String(value || fallback || '').trim();
  if (!rawValue) return '';
  let match = /^(\d{4})(\d{2})(\d{2})$/.exec(rawValue);
  if (match) return formatDateParts(match[1], match[2], match[3]) || rawValue;
  match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s.*)?$/.exec(rawValue);
  if (match) return formatDateParts(match[1], match[2], match[3]) || rawValue;
  return rawValue.slice(0, 10);
}

/**
 * 方法说明：清理库名、表名等标识符文本并转为小写。
 * @param {*} value - 待处理的输入值。
 * @returns {*} - 方法执行结果。
 */
function normalizeIdentifierText(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * 方法说明：拆分可带库名前缀的表名并统一表名格式。
 * @param {*} value - 待处理的输入值。
 * @returns {*} - 方法执行结果。
 */
function normalizeTableName(value) {
  return normalizeIdentifierText(value);
}

/**
 * 方法说明：读取视图查询默认数据库配置。
 * @returns {*} - 方法执行结果。
 */
function getViewDatabase() {
  const viewDatabase = normalizeIdentifierText(process.env.VIEW_DATABASE || 'fdm');
  validateIdentifier(viewDatabase, '视图库名');
  return viewDatabase;
}

/**
 * 方法说明：判断当前是否允许访问真实 Hive 和 HDFS。
 * @returns {*} - 方法执行结果。
 */
function isExecutionEnabled() {
  return process.env.RECOVERY_EXECUTE === '1';
}

/**
 * 方法说明：返回当前真实执行或 dry-run 模式的说明信息。
 * @returns {*} - 方法执行结果。
 */
function getExecutionMeta() {
  return {
    dryRun: !isExecutionEnabled(),
    executeEnabled: isExecutionEnabled(),
    envFileLoaded: fs.existsSync(envPath),
    recoveryExecute: process.env.RECOVERY_EXECUTE || ''
  };
}

/**
 * 方法说明：校验数据库、表名和配置字段是否符合安全标识符格式。
 * @param {*} value - 待处理的输入值。
 * @param {*} label - 状态或日志标签。
 * @returns {*} - 方法执行结果。
 */
function validateIdentifier(value, label) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(value || ''))) {
    throw new Error(`${label}不合法：${value}`);
  }
}

/**
 * 方法说明：校验任务开始日期和结束日期均有效且顺序正确。
 * @param {*} row - 当前任务行对象。
 * @returns {*} - 方法执行结果。
 */
function validateDateRange(row) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(row.endDate || '')) {
    throw new Error(`日期范围不合法：${row.startDate || '空'} 至 ${row.endDate || '空'}`);
  }
  if (row.startDate > row.endDate) throw new Error(`开始日期晚于结束日期：${row.startDate} 至 ${row.endDate}`);
}

/**
 * 方法说明：校验允许为空的日期字段及其日期顺序。
 * @param {*} row - 当前任务行对象。
 * @returns {*} - 方法执行结果。
 */
function validateOptionalDateRange(row) {
  if (row.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(row.startDate)) {
    throw new Error(`开始日期格式不合法：${row.startDate}`);
  }
  if (row.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(row.endDate)) {
    throw new Error(`结束日期格式不合法：${row.endDate}`);
  }
  if (row.startDate && row.endDate && row.startDate > row.endDate) {
    throw new Error(`开始日期晚于结束日期：${row.startDate} 至 ${row.endDate}`);
  }
}

/**
 * 方法说明：将清单中的异常行转换为可展示和可跳过的失败行。
 * @param {*} row - 当前任务行对象。
 * @param {*} error - 捕获到的错误对象。
 * @returns {*} - 方法执行结果。
 */
function markInvalidListRow(row, error) {
  return {
    ...row,
    status: 'failed',
    statusText: `清单校验失败：${error.message}`,
    error: error.message
  };
}

/**
 * 方法说明：校验清单行日期并返回标准化日期结果。
 * @param {*} row - 当前任务行对象。
 * @returns {*} - 方法执行结果。
 */
function validateListRowDate(row) {
  try {
    validateDateRange(row);
    return row;
  } catch (error) {
    return markInvalidListRow(row, error);
  }
}

/**
 * 方法说明：校验 HDFS 表路径非空且不包含危险根路径。
 * @param {*} tablePath - Hive 表对应的 HDFS 路径。
 * @returns {*} - 方法执行结果。
 */
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

async function runCommandAsync(command, args, options = {}) {
  const job = options.job;
  await jobCheckpoint(job);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      detached: true,
      env: process.env
    });
    registerJobChild(job, child);
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
    child.on('error', (error) => {
      unregisterJobChild(job, child);
      reject(error);
    });
    child.on('exit', (code) => {
      unregisterJobChild(job, child);
      if (job?.cancelRequested) {
        reject(makeCanceledError());
        return;
      }
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

/**
 * 方法说明：同步检查指定 HDFS 路径是否为存在的目录。
 * @param {*} tablePath - Hive 表对应的 HDFS 路径。
 * @returns {*} - 方法执行结果。
 */
function hdfsTestDir(tablePath) {
  return runHdfsCommand(['-test', '-d', tablePath], { allowFailure: true }).status === 0;
}

/**
 * 方法说明：执行单值 Hive 查询并提取第一条有效结果。
 * @param {*} sql - 待执行的 SQL 文本。
 * @returns {*} - 方法执行结果。
 */
function queryScalar(sql) {
  const output = runBeeline(['-e', sql]);
  for (const rawLine of output.split(/\r?\n/)) {
    const line = cleanBeelineLine(rawLine);
    if (line) return line;
  }
  return '';
}

/**
 * 方法说明：读取并校验日期分区字段配置，默认使用 tx_dt。
 * @returns {*} - 方法执行结果。
 */
function getPartitionColumn() {
  const partitionColumn = process.env.PARTITION_COLUMN || 'tx_dt';
  validateIdentifier(partitionColumn, '分区字段名');
  return partitionColumn;
}

/**
 * 方法说明：按页面输入、环境变量和默认值确定跨库源数据库。
 * @param {*} inputDatabase - 方法输入的 inputDatabase 参数。
 * @returns {*} - 方法执行结果。
 */
function getSourceDatabase(inputDatabase = '') {
  const sourceDatabase = normalizeIdentifierText(inputDatabase || process.env.SOURCE_DATABASE || 'prodb_dm');
  validateIdentifier(sourceDatabase, '源库名');
  return sourceDatabase;
}

/**
 * 方法说明：生成库名和表名组成的内部缓存键。
 * @param {*} row - 当前任务行对象。
 * @returns {*} - 方法执行结果。
 */
function tableKey(row) {
  return `${row.databaseName}.${row.tableName}`;
}

/**
 * 方法说明：按大小写不敏感条件查询 Hive 表的 HDFS 存储路径。
 * @param {*} databaseName - 数据库名称。
 * @param {*} tableName - 表名称。
 * @returns {*} - 方法执行结果。
 */
function getTableLocation(databaseName, tableName) {
  validateIdentifier(databaseName, '库名');
  validateIdentifier(tableName, '表名');
  const locationColumn = process.env.TABLE_LOCATION_COLUMN || 'table_location';
  validateIdentifier(locationColumn, '表路径字段名');
  const tablePath = queryScalar(
    `SELECT ${locationColumn} FROM system.tables_v WHERE lower(database_name)=lower('${sqlString(databaseName)}') AND lower(table_name)=lower('${sqlString(tableName)}')`
  );
  if (!tablePath) throw new Error(`未查询到表路径：${databaseName}.${tableName}`);
  validateHdfsTablePath(tablePath);
  return tablePath;
}

/**
 * 方法说明：优先查询分区元数据并在必要时检查建表语句。
 * @param {*} databaseName - 数据库名称。
 * @param {*} tableName - 表名称。
 * @returns {*} - 方法执行结果。
 */
function isPartitionedTable(databaseName, tableName) {
  validateIdentifier(databaseName, '库名');
  validateIdentifier(tableName, '表名');
  const count = queryScalar(
    `SELECT count(1) FROM system.partition_keys_all_v WHERE lower(database_name)=lower('${sqlString(databaseName)}') AND lower(table_name)=lower('${sqlString(tableName)}')`
  );
  if (!/^\d+$/.test(count)) throw new Error(`无法判断 ${databaseName}.${tableName} 是否为分区表，查询结果：${count || '空'}`);
  if (Number(count) > 0) return true;

  // Some internal metadata views do not expose partition keys consistently;
  // use the table DDL as a second source before classifying it as non-partitioned.
  try {
    const ddl = runBeeline(['-e', `SHOW CREATE TABLE ${databaseName}.${tableName}`]);
    return /\bPARTITIONED\s+BY\b/i.test(ddl);
  } catch {
    return false;
  }
}

/**
 * 方法说明：读取跨库表级并发数并限制在安全上限内。
 * @returns {*} - 方法执行结果。
 */
function getCrossTableConcurrency() {
  const configured = Number.parseInt(process.env.CROSS_TABLE_CONCURRENCY || '2', 10);
  return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 4) : 2;
}

/**
 * 方法说明：从 hdfs ls 输出中提取指定分区字段的日期集合。
 * @param {*} output - 方法输入的 output 参数。
 * @param {*} partitionColumn - 日期分区字段名。
 * @returns {*} - 方法执行结果。
 */
function parseHdfsPartitionDates(output, partitionColumn) {
  const escapedColumn = String(partitionColumn).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escapedColumn}=(\\d{4}-\\d{2}-\\d{2})/?$`);
  const dates = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const candidate = fields[fields.length - 1] || '';
    const match = pattern.exec(candidate);
    if (match) dates.add(match[1]);
  }
  return dates;
}

/**
 * 方法说明：批量列出 HDFS 表下的日期分区并解析结果。
 * @param {*} tablePath - Hive 表对应的 HDFS 路径。
 * @param {*} partitionColumn - 日期分区字段名。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function listHdfsPartitionDatesAsync(tablePath, partitionColumn, job) {
  const root = tablePath.replace(/\/+$/, '');
  const result = await runHdfsCommandAsync(['-ls', '-d', `${root}/${partitionColumn}=*`], {
    job,
    allowFailure: true
  });
  if (result.status !== 0) return null;
  return parseHdfsPartitionDates(result.stdout, partitionColumn);
}

/**
 * 方法说明：优先批量复制跨库分区，失败后逐分区重试。
 * @param {*} job - 当前后台任务对象。
 * @param {*} row - 当前任务行对象。
 * @param {*} sourcePartitions - 源日期分区路径数组。
 * @param {*} targetPartitions - 目标日期分区路径数组。
 * @param {*} targetTableRoot - 目标表 HDFS 根目录。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function copyCrossPartitionsAsync(job, row, sourcePartitions, targetPartitions, targetTableRoot) {
  const sourceCount = sourcePartitions.length;
  try {
    job.logs.push(`批量复制 ${sourceCount} 个跨库分区：${row.tableName}`);
    await runWithProgressHeartbeat(job, [row], `批量复制跨库分区 1/${sourceCount}`, 88, () => (
      runHdfsCommandAsync(['-cp', ...sourcePartitions, `${targetTableRoot}/`], {
        job,
        onData: (chunk) => appendLog(job, chunk)
      })
    ));
    row.progress = Math.max(row.progress || 0, 90);
    sendJob(job);
    return;
  } catch (batchError) {
    job.logs.push(`批量复制跨库分区失败，切换逐分区复制：${batchError.message}`);
    sendJob(job);
  }

  for (let index = 0; index < sourcePartitions.length; index += 1) {
    await jobCheckpoint(job);
    const sourcePartition = sourcePartitions[index];
    const targetPartition = targetPartitions[index];
    job.logs.push(`逐分区复制 ${index + 1}/${sourceCount}：${sourcePartition} -> ${targetPartition}/`);
    await runWithProgressHeartbeat(job, [row], `逐分区复制 ${index + 1}/${sourceCount}`, 88, () => (
      runHdfsCommandAsync(['-mkdir', '-p', targetPartition], { job })
        .then(() => runHdfsCommandAsync([
          '-cp', '-f', `${sourcePartition.replace(/\/+$/, '')}/*`, `${targetPartition.replace(/\/+$/, '')}/`
        ], { job, onData: (chunk) => appendLog(job, chunk) }))
    ));
    row.progress = Math.max(row.progress || 0, Math.min(90, Math.round(52 + ((index + 1) / sourceCount) * 38)));
    sendJob(job);
  }
}

/**
 * 方法说明：按配置批量补充目标表分区元数据或执行 MSCK。
 * @param {*} job - 当前后台任务对象。
 * @param {*} row - 当前任务行对象。
 * @param {*} targetPartitions - 目标日期分区路径数组。
 * @param {*} partitionColumn - 日期分区字段名。
 * @param {*} configuredMode - 配置的分区修复模式。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function repairHdfsPartitionsAsync(job, row, targetPartitions, partitionColumn, configuredMode = '') {
  const repairMode = String(configuredMode || process.env.PARTITION_REPAIR_MODE || 'add').toLowerCase();
  if (repairMode === 'msck') {
    job.logs.push(`按配置执行全表分区修复：${row.databaseName}.${row.tableName}`);
    await runWithProgressHeartbeat(job, [row], '修复 Hive 分区中', 92, () => (
      runBeelineAsync(['-e', `USE ${row.databaseName};MSCK REPAIR TABLE ${row.tableName}`], {
        job,
        onData: (chunk) => appendLog(job, chunk)
      })
    ));
    return;
  }

  const partitionClauses = targetPartitions.map((partitionPath) => {
    const match = new RegExp(`${String(partitionColumn).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=(\\d{4}-\\d{2}-\\d{2})$`).exec(partitionPath);
    if (!match) throw new Error(`无法从目标分区路径识别日期：${partitionPath}`);
    return `PARTITION (${partitionColumn}='${match[1]}') LOCATION '${sqlString(partitionPath)}'`;
  }).join(' ');

  try {
    job.logs.push(`按明确分区位置补充 Hive 元数据：${targetPartitions.length} 个分区`);
    await runWithProgressHeartbeat(job, [row], '补充 Hive 分区元数据中', 92, () => (
      runBeelineAsync(['-e', `USE ${row.databaseName};ALTER TABLE ${row.tableName} ADD IF NOT EXISTS ${partitionClauses}`], {
        job,
        onData: (chunk) => appendLog(job, chunk)
      })
    ));
  } catch (error) {
    job.logs.push(`批量补充分区元数据失败，回退 MSCK REPAIR：${error.message}`);
    await runWithProgressHeartbeat(job, [row], '回退修复 Hive 分区中', 92, () => (
      runBeelineAsync(['-e', `USE ${row.databaseName};MSCK REPAIR TABLE ${row.tableName}`], {
        job,
        onData: (chunk) => appendLog(job, chunk)
      })
    ));
  }
}

/**
 * 方法说明：读取恢复表级并发配置并限制并发上限。
 * @returns {*} - 方法执行结果。
 */
function getRecoveryTableConcurrency() {
  const configured = Number.parseInt(process.env.RECOVERY_TABLE_CONCURRENCY || '2', 10);
  return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 4) : 2;
}

/**
 * 方法说明：按目标表分组，在保持同表串行的前提下受控并发执行。
 * @param {*} job - 当前后台任务对象。
 * @param {*} rows - 任务行数组。
 * @param {*} processRow - 方法输入的 processRow 参数。
 * @param {*} label - 状态或日志标签。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function executeRestoreRowsByTable(job, rows, processRow, label) {
  const groupsByTable = new Map();
  for (const row of rows) {
    const key = `${row.databaseName || ''}.${row.tableName || ''}`;
    if (!groupsByTable.has(key)) groupsByTable.set(key, []);
    groupsByTable.get(key).push(row);
  }
  const groups = [...groupsByTable.values()];
  const concurrency = Math.min(getRecoveryTableConcurrency(), groups.length || 1);
  job.logs.push(`${label}启用 ${concurrency} 路表级并发，同一目标表内任务保持串行。`);
  sendJob(job);
  let nextGroupIndex = 0;
  /**
   * 方法说明：从共享任务索引中领取下一组任务并执行该组任务。
   * @returns {Promise<*>} - 方法执行结果。
   */
  async function worker() {
    while (true) {
      const groupIndex = nextGroupIndex;
      nextGroupIndex += 1;
      if (groupIndex >= groups.length) return;
      for (const row of groups[groupIndex]) await processRow(row);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

/**
 * 方法说明：校验本地目录配置存在且确实为目录。
 * @param {*} dirPath - 方法输入的 dirPath 参数。
 * @param {*} label - 状态或日志标签。
 * @returns {*} - 方法执行结果。
 */
function ensureLocalDirectory(dirPath, label) {
  if (!dirPath) throw new Error(`${label}不能为空`);
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`${label}不存在：${resolved}`);
  return resolved;
}

/**
 * 方法说明：创建并校验可写的本地根目录。
 * @param {*} dirPath - 方法输入的 dirPath 参数。
 * @param {*} label - 状态或日志标签。
 * @returns {*} - 方法执行结果。
 */
function ensureWritableRootDirectory(dirPath, label) {
  if (!dirPath) throw new Error(`${label}不能为空`);
  const resolved = path.resolve(dirPath);
  if (resolved === path.parse(resolved).root) throw new Error(`${label}不能是根目录：${resolved}`);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/**
 * 方法说明：列出目录下的普通文件，不递归处理子目录。
 * @param {*} dirPath - 方法输入的 dirPath 参数。
 * @returns {*} - 方法执行结果。
 */
function listRegularFiles(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
  return fs.readdirSync(dirPath)
    .map((fileName) => path.join(dirPath, fileName))
    .filter((filePath) => fs.statSync(filePath).isFile());
}

/**
 * 方法说明：将源目录中的普通文件复制到目标目录。
 * @param {*} sourceDir - 方法输入的 sourceDir 参数。
 * @param {*} targetDir - 方法输入的 targetDir 参数。
 * @returns {*} - 方法执行结果。
 */
function copyRegularFiles(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const files = listRegularFiles(sourceDir);
  for (const filePath of files) {
    const targetPath = path.join(targetDir, path.basename(filePath));
    fs.copyFileSync(filePath, targetPath);
  }
  return files.length;
}

/**
 * 方法说明：在安全边界校验通过后删除中转目录。
 * @param {*} rootPath - 方法输入的 rootPath 参数。
 * @param {*} targetPath - 方法输入的 targetPath 参数。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：组装 HiveServer2 Beeline 连接和输出参数。
 * @param {*} extraArgs - 方法输入的 extraArgs 参数。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：在配置完整时执行 Kerberos 登录。
 * @returns {*} - 方法执行结果。
 */
function kerberosLoginIfPossible() {
  const keytab = process.env.KRB_KEYTAB || '/home/tyf/etc/ekg.keytab';
  const principal = process.env.KRB_PRINCIPAL || 'ekg@TDH';
  if (fs.existsSync(keytab)) {
    const result = spawnSync('kinit', ['-kt', keytab, principal], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Kerberos 认证失败：${result.stderr || result.stdout}`);
  }
}

/**
 * 方法说明：异步执行 Kerberos 登录并写入任务日志。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function kerberosLoginIfPossibleAsync(job) {
  const keytab = process.env.KRB_KEYTAB || '/home/tyf/etc/ekg.keytab';
  const principal = process.env.KRB_PRINCIPAL || 'ekg@TDH';
  if (!fs.existsSync(keytab)) return;
  try {
    await runCommandAsync('kinit', ['-kt', keytab, principal], { job });
  } catch (error) {
    throw new Error(`Kerberos 认证失败：${error.message}`);
  }
}

/**
 * 方法说明：同步执行 Beeline 查询并返回文本结果。
 * @param {*} extraArgs - 方法输入的 extraArgs 参数。
 * @returns {*} - 方法执行结果。
 */
function runBeeline(extraArgs) {
  kerberosLoginIfPossible();
  const result = spawnSync('beeline', getBeelineArgs(extraArgs), { cwd: rootDir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`beeline 执行失败：${result.stderr || result.stdout}`);
  return result.stdout;
}

async function runBeelineAsync(extraArgs, options = {}) {
  await kerberosLoginIfPossibleAsync(options.job);
  const result = await runCommandAsync('beeline', getBeelineArgs(extraArgs), options);
  return result.stdout;
}

/**
 * 方法说明：清理 Beeline 输出中的引号、空白和表头内容。
 * @param {*} line - 方法输入的 line 参数。
 * @returns {*} - 方法执行结果。
 */
function cleanBeelineLine(line) {
  return String(line || '')
    .trim()
    .replace(/\r/g, '')
    .replace(/^"|"$/g, '')
    .replace(/""/g, '"');
}

/**
 * 方法说明：转义 SQL 字符串中的单引号。
 * @param {*} value - 待处理的输入值。
 * @returns {*} - 方法执行结果。
 */
function sqlString(value) {
  return String(value ?? '').replace(/'/g, "''");
}

/**
 * 方法说明：查询指定数据库下的全部表名。
 * @param {*} databaseName - 数据库名称。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：读取 Shell 任务配置并转换为任务行。
 * @param {*} filePath - 输入或输出文件路径。
 * @returns {*} - 方法执行结果。
 */
function parseTaskConfig(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line, index) => {
      const parts = line.replace(/\|/g, ' ').split(/\s+/);
      if (parts.length === 5) {
        const row = makeRow({
          id: `view-${index + 1}`,
          viewName: normalizeIdentifierText(parts[0]),
          databaseName: normalizeIdentifierText(parts[1]),
          tableName: normalizeTableName(parts[2]),
          startDate: normalizeDate(parts[3]),
          endDate: normalizeDate(parts[4])
        });
        validateDateRange(row);
        return row;
      }
      const row = makeRow({
        id: `task-${index + 1}`,
        databaseName: normalizeIdentifierText(parts[0]),
        tableName: normalizeTableName(parts[1]),
        startDate: normalizeDate(parts[2]),
        endDate: normalizeDate(parts[3])
      });
      validateDateRange(row);
      return row;
    });
}

/**
 * 方法说明：在 dry-run 模式下使用本地映射解析视图源表。
 * @param {*} viewName - 方法输入的 viewName 参数。
 * @returns {*} - 方法执行结果。
 */
function fallbackResolveView(viewName) {
  const mapPath = process.env.VIEW_SOURCE_MAP_JSON || path.join(rootDir, 'view-source-map.json');
  if (fs.existsSync(mapPath)) {
    const mapped = JSON.parse(fs.readFileSync(mapPath, 'utf8'))[viewName];
    if (mapped) return Array.isArray(mapped) ? mapped : [mapped];
  }
  const clean = String(viewName || '').replace(/^v_/i, '').replace(/^view_/i, '');
  const parts = clean.includes('.') ? clean.split('.', 2) : ['prodb_dm', clean || 'unknown_table'];
  return [{ databaseName: normalizeIdentifierText(parts[0]), tableName: normalizeTableName(parts[1]) }];
}

/**
 * 方法说明：解析视图库名和视图名并统一为小写。
 * @param {*} viewName - 方法输入的 viewName 参数。
 * @returns {*} - 方法执行结果。
 */
function normalizeViewName(viewName) {
  const viewDatabase = getViewDatabase();
  const normalized = String(viewName || '').trim().toLowerCase();
  const fullName = normalized.includes('.') ? normalized : `${viewDatabase}.${normalized}`;
  const [databaseName, tableName] = fullName.split('.', 2);
  validateIdentifier(databaseName, '视图库名');
  validateIdentifier(tableName, '视图名');
  if (databaseName !== viewDatabase) throw new Error(`仅允许查询 ${viewDatabase} 库中的视图，收到：${fullName}`);
  return fullName;
}

/**
 * 方法说明：去除 SQL 注释和字符串，降低表名误识别。
 * @param {*} sql - 待执行的 SQL 文本。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：从视图 SQL 的 FROM 和 JOIN 中提取基础表。
 * @param {*} sql - 待执行的 SQL 文本。
 * @param {*} rootView - 方法输入的 rootView 参数。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：同步查询视图定义 SQL。
 * @param {*} viewName - 方法输入的 viewName 参数。
 * @returns {*} - 方法执行结果。
 */
function queryViewOriginText(viewName) {
  const [databaseName, tableName] = viewName.split('.', 2);
  const output = runBeeline(['-e',
    `SELECT origin_text FROM system.views_v WHERE database_name='${sqlString(databaseName)}' AND view_name='${sqlString(tableName)}' LIMIT 1`
  ]);
  const originText = cleanBeelineLine(output.trim());
  if (!originText) throw new Error(`system.views_v 中未找到视图或 origin_text 为空：${viewName}`);
  return originText;
}

/**
 * 方法说明：异步查询视图定义 SQL 并写入任务日志。
 * @param {*} viewName - 方法输入的 viewName 参数。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function queryViewOriginTextAsync(viewName, job) {
  const [databaseName, tableName] = viewName.split('.', 2);
  const output = await runBeelineAsync(['-e',
    `SELECT origin_text FROM system.views_v WHERE database_name='${sqlString(databaseName)}' AND view_name='${sqlString(tableName)}' LIMIT 1`
  ], { job });
  const originText = cleanBeelineLine(output.trim());
  if (!originText) throw new Error(`system.views_v 中未找到视图或 origin_text 为空：${viewName}`);
  return originText;
}

/**
 * 方法说明：递归展开嵌套视图并得到基础源表。
 * @param {*} rootView - 方法输入的 rootView 参数。
 * @param {*} currentView - 方法输入的 currentView 参数。
 * @param {*} visited - 方法输入的 visited 参数。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：异步递归解析嵌套视图并缓存重复查询。
 * @param {*} rootView - 方法输入的 rootView 参数。
 * @param {*} currentView - 方法输入的 currentView 参数。
 * @param {*} job - 当前后台任务对象。
 * @param {*} visited - 方法输入的 visited 参数。
 * @param {*} expansionCache - 方法输入的 expansionCache 参数。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function expandViewSourcesNativeAsync(rootView, currentView, job, visited = new Set(), expansionCache = new Map()) {
  if (visited.has(currentView)) throw new Error(`检测到视图循环依赖：${[...visited, currentView].join('|')}`);
  if (expansionCache.has(currentView)) return expansionCache.get(currentView);

  const nextVisited = new Set(visited);
  nextVisited.add(currentView);
  const viewDatabase = String(process.env.VIEW_DATABASE || 'fdm').toLowerCase();
  const originText = await queryViewOriginTextAsync(currentView, job);
  const sourceTables = extractBaseTablesFromSql(originText, currentView);
  const rows = [];
  for (const source of sourceTables) {
    if (source.databaseName === viewDatabase) {
      const nestedRows = await expandViewSourcesNativeAsync(
        rootView,
        `${source.databaseName}.${source.tableName}`,
        job,
        nextVisited,
        expansionCache
      );
      rows.push(...nestedRows);
    } else {
      rows.push(source);
    }
  }
  const seen = new Set();
  const resolvedRows = rows.filter((source) => {
    const key = `${source.databaseName}.${source.tableName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  expansionCache.set(currentView, resolvedRows);
  return resolvedRows;
}

/**
 * 方法说明：将视图源表解析结果转换为恢复清单行。
 * @param {*} items - 方法输入的 items 参数。
 * @param {*} fields - 解析后的表单字段。
 * @param {*} inputPath - 方法输入的 inputPath 参数。
 * @returns {*} - 方法执行结果。
 */
function buildRowsFromViewNative(items, fields, inputPath) {
  const rows = [];
  const recoverLines = [];
  const seen = new Set();

  items.forEach((item, index) => {
    if (!item.viewName) return;
    const rawViewName = normalizeIdentifierText(item.viewName);
    let viewName = rawViewName;
    const startDate = normalizeDate(item.startDate, fields.startDate);
    const endDate = normalizeDate(item.endDate, fields.endDate);
    try {
      viewName = normalizeViewName(rawViewName);
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
    } catch (error) {
      rows.push(markInvalidListRow(makeRow({
        id: `view-${index + 1}-invalid`,
        viewName,
        databaseName: '',
        tableName: '-',
        startDate,
        endDate
      }), error));
    }
  });

  if (!rows.length) throw new Error('Node 后端未解析到视图源表');
  const configPath = writeTaskConfig(rows, 'view');
  fs.writeFileSync(path.join(path.dirname(configPath), 'prod_data_recover.txt'), `${[...new Set(recoverLines)].sort().join('\n')}\n`);
  return { rows, configPath, viewInputPath: inputPath };
}

/**
 * 方法说明：异步解析多个视图并生成恢复清单行。
 * @param {*} items - 方法输入的 items 参数。
 * @param {*} fields - 解析后的表单字段。
 * @param {*} inputPath - 方法输入的 inputPath 参数。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function buildRowsFromViewNativeAsync(items, fields, inputPath, job) {
  const rows = [];
  const recoverLines = [];
  const seen = new Set();
  const expansionCache = new Map();
  const heartbeat = createCountProgressHeartbeat(job, '正在解析视图源表', {
    intervalMs: 5000,
    minProgress: 8,
    maxProgress: 20,
    step: 1
  });

  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item.viewName) continue;
      const viewName = normalizeViewName(item.viewName);
      const startDate = normalizeDate(item.startDate, fields.startDate);
      const endDate = normalizeDate(item.endDate, fields.endDate);
      validateDateRange({ startDate, endDate });
      job.logs.push(`解析视图源表：${viewName}`);
      setCountProgress(job, 'running', Math.min(20, 8 + index), '正在解析视图源表。');
      const sources = await expandViewSourcesNativeAsync(viewName, viewName, job, new Set(), expansionCache);
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
    }
  } finally {
    clearInterval(heartbeat);
  }

  if (!rows.length) throw new Error('Node 后端未解析到视图源表');
  const configPath = writeTaskConfig(rows, 'count-view');
  fs.writeFileSync(path.join(path.dirname(configPath), 'prod_data_recover.txt'), `${[...new Set(recoverLines)].sort().join('\n')}\n`);
  return { rows, configPath, viewInputPath: inputPath };
}

/**
 * 方法说明：解析 Shell 视图脚本输出并构造恢复行。
 * @param {*} items - 方法输入的 items 参数。
 * @param {*} fields - 解析后的表单字段。
 * @returns {*} - 方法执行结果。
 */
function buildRowsFromViewScript(items, fields) {
  const stamp = Date.now();
  const inputPath = path.join(generatedDir, `views-${stamp}.txt`);
  const outputPath = path.join(generatedDir, `view-source-tables-${stamp}.txt`);
  const input = items
    .filter((item) => item.viewName)
    .map((item) => [
      normalizeViewName(item.viewName),
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
    if (!item.viewName) return [];
    const rawViewName = normalizeIdentifierText(item.viewName);
    const startDate = normalizeDate(item.startDate, fields.startDate);
    const endDate = normalizeDate(item.endDate, fields.endDate);
    try {
      const viewName = normalizeViewName(rawViewName);
      validateDateRange({ startDate, endDate });
      return fallbackResolveView(viewName).map((source, sourceIndex) => makeRow({
        id: `view-${index + 1}-${sourceIndex + 1}`,
        viewName,
        databaseName: normalizeIdentifierText(source.databaseName),
        tableName: normalizeTableName(source.tableName),
        startDate,
        endDate
      }));
    } catch (error) {
      return [markInvalidListRow(makeRow({
        id: `view-${index + 1}-invalid`,
        viewName: rawViewName,
        databaseName: '',
        tableName: '-',
        startDate,
        endDate
      }), error)];
    }
  });
  const configPath = writeTaskConfig(rows, 'view');
  return { rows, configPath, viewInputPath: inputPath };
}

/**
 * 方法说明：标准化视图源表查询输入行。
 * @param {*} items - 方法输入的 items 参数。
 * @returns {*} - 方法执行结果。
 */
function buildViewSourceInputRows(items) {
  const rows = items.filter((item) => item.viewName).map((item, index) => {
    const rawViewName = normalizeIdentifierText(item.viewName);
    const startDate = normalizeDate(item.startDate);
    const endDate = normalizeDate(item.endDate);
    try {
      validateOptionalDateRange({ startDate, endDate });
      return makeRow({
        id: `view-source-input-${index + 1}`,
        viewName: normalizeViewName(rawViewName),
        databaseName: '',
        tableName: '',
        startDate,
        endDate
      });
    } catch (error) {
      return markInvalidListRow(makeRow({
        id: `view-source-input-${index + 1}`,
        viewName: rawViewName,
        databaseName: '',
        tableName: '-',
        startDate,
        endDate
      }), error);
    }
  });
  if (!rows.length) throw new Error('视图源表查询清单中未识别到视图名');
  return { rows, configPath: writeTaskConfig(rows, 'view-source-input') };
}

/**
 * 方法说明：将视图源表查询行写入临时输入文件。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
function writeViewSourceInputFile(rows) {
  const inputPath = path.join(generatedDir, `view-source-query-${Date.now()}.txt`);
  const body = rows
    .filter((row) => row.status !== 'failed')
    .map((row) => [row.viewName, row.startDate || '', row.endDate || ''].join('|'))
    .join('\n');
  fs.writeFileSync(inputPath, `${body}\n`);
  return inputPath;
}

/**
 * 方法说明：构造视图源表查询失败行并保留原始输入。
 * @param {*} row - 当前任务行对象。
 * @param {*} error - 捕获到的错误对象。
 * @returns {*} - 方法执行结果。
 */
function makeViewSourceFailureRow(row, error) {
  return markInvalidListRow(makeRow({
    ...row,
    databaseName: '',
    tableName: '-'
  }), error);
}

/**
 * 方法说明：并发执行视图源表 Node 查询并汇总结果。
 * @param {*} inputRows - 标准化后的输入行数组。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function buildViewSourceRowsNativeAsync(inputRows, job) {
  const rows = inputRows.filter((row) => row.status === 'failed').map((row) => makeRow({
    ...row,
    progress: 100,
    status: 'failed',
    statusText: row.statusText || statusText.failed
  }));
  const failures = [];
  const validRows = inputRows.filter((row) => row.status !== 'failed');
  const expansionCache = new Map();
  const resolvedRows = new Array(validRows.length);
  const configured = Number.parseInt(process.env.VIEW_SOURCE_QUERY_CONCURRENCY || '4', 10);
  const requestedConcurrency = Number.isInteger(configured) && configured > 0 ? Math.min(configured, 8) : 4;
  const concurrency = Math.min(requestedConcurrency, validRows.length || 1);
  let nextIndex = 0;

  job.logs.push(`视图源表查询启用 ${concurrency} 路受控并发，并复用重复视图的解析结果。`);
  sendJob(job);

  /**
   * 方法说明：从共享任务索引中领取下一组任务并执行该组任务。
   * @returns {Promise<*>} - 方法执行结果。
   */
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= validRows.length) return;
      const inputRow = validRows[index];
      inputRow.status = 'running';
      inputRow.statusText = '正在查询视图源表';
      inputRow.progress = Math.max(inputRow.progress || 0, 10);
      sendJob(job);
      try {
        const sources = await expandViewSourcesNativeAsync(
          inputRow.viewName,
          inputRow.viewName,
          job,
          new Set(),
          expansionCache
        );
        if (!sources.length) throw new Error(`未解析到视图源表：${inputRow.viewName}`);
        resolvedRows[index] = sources.map((source, sourceIndex) => makeRow({
          id: `view-source-${inputRow.id}-${sourceIndex + 1}`,
          viewName: inputRow.viewName,
          databaseName: normalizeIdentifierText(source.databaseName),
          tableName: normalizeTableName(source.tableName),
          startDate: inputRow.startDate || '',
          endDate: inputRow.endDate || '',
          progress: 100,
          status: 'completed',
          statusText: statusText.completed
        }));
        inputRow.progress = 100;
        inputRow.status = 'completed';
        inputRow.statusText = `已查询 ${sources.length} 个源表`;
        sendJob(job);
      } catch (error) {
        const failureRow = makeViewSourceFailureRow(inputRow, error);
        resolvedRows[index] = [failureRow];
        failures.push({ row: failureRow, error: error.message });
        inputRow.progress = 100;
        inputRow.status = 'failed';
        inputRow.statusText = `查询失败：${error.message}`;
        sendJob(job);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  for (const result of resolvedRows) {
    if (result) rows.push(...result);
  }

  if (failures.length) {
    const error = new Error(`Node 视图源表查询失败 ${failures.length} 行`);
    error.failures = failures;
    throw error;
  }
  return rows;
}

/**
 * 方法说明：在未开启真实执行时生成视图源表模拟结果。
 * @param {*} inputRows - 标准化后的输入行数组。
 * @returns {*} - 方法执行结果。
 */
function buildViewSourceRowsDryRun(inputRows) {
  return inputRows.flatMap((inputRow) => {
    if (inputRow.status === 'failed') {
      return [makeRow({
        ...inputRow,
        progress: 100,
        status: 'failed',
        statusText: inputRow.statusText || statusText.failed
      })];
    }
    try {
      const sources = fallbackResolveView(inputRow.viewName);
      return sources.map((source, sourceIndex) => makeRow({
        id: `view-source-dry-run-${inputRow.id}-${sourceIndex + 1}`,
        viewName: inputRow.viewName,
        databaseName: normalizeIdentifierText(source.databaseName),
        tableName: normalizeTableName(source.tableName),
        startDate: inputRow.startDate || '',
        endDate: inputRow.endDate || '',
        progress: 100,
        status: 'completed',
        statusText: statusText.completed
      }));
    } catch (error) {
      return [makeViewSourceFailureRow(inputRow, error)];
    }
  });
}

/**
 * 方法说明：解析 Shell 视图源表查询输出文件。
 * @param {*} filePath - 输入或输出文件路径。
 * @returns {*} - 方法执行结果。
 */
function parseViewSourceScriptOutput(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const fields = line.split('|');
      if (fields.length < 5) return null;
      return makeRow({
        id: `view-source-shell-${index + 1}`,
        viewName: normalizeIdentifierText(fields[0]),
        databaseName: normalizeIdentifierText(fields[1]),
        tableName: normalizeTableName(fields[2]),
        startDate: normalizeDate(fields[3]),
        endDate: normalizeDate(fields[4]),
        progress: 100,
        status: 'completed',
        statusText: statusText.completed
      });
    })
    .filter(Boolean);
}

/**
 * 方法说明：执行视图源表 Shell 备用脚本并读取输出。
 * @param {*} inputPath - 方法输入的 inputPath 参数。
 * @param {*} outputPath - 输出文件路径。
 * @returns {*} - 方法执行结果。
 */
function runViewSourceScriptFallback(inputPath, outputPath) {
  const scriptPath = path.join(scriptDir, 'view_to_source_tables.sh');
  if (!fs.existsSync(scriptPath)) throw new Error(`脚本不存在：${scriptPath}`);
  const result = spawnSync('bash', [scriptPath, inputPath, outputPath], {
    cwd: rootDir,
    encoding: 'utf8',
    env: { ...process.env, VIEW_SOURCE_QUERY: '1' }
  });
  // The script exits with 2 when some input views fail but still writes valid rows.
  if (result.status !== 0 && result.status !== 2) {
    throw new Error(`view_to_source_tables.sh 执行失败：${result.stderr || result.stdout || `退出码 ${result.status}`}`);
  }
  return {
    rows: parseViewSourceScriptOutput(outputPath),
    log: result.stderr || result.stdout || ''
  };
}

/**
 * 方法说明：把视图源表结果写入任务结果 Excel。
 * @param {*} job - 当前后台任务对象。
 * @returns {*} - 方法执行结果。
 */
function writeViewSourceSummaryWorkbook(job) {
  const fileName = `view-source-summary-${job.id}.xlsx`;
  const filePath = path.join(generatedDir, fileName);
  fs.writeFileSync(filePath, makeViewSourceSummaryXlsx(job.rows));
  job.summaryFile = {
    fileName,
    filePath,
    url: `/api/jobs/${job.id}/view-source.xlsx`
  };
}

/**
 * 方法说明：根据清单模式读取字段、校验日期并生成任务行。
 * @param {*} fields - 解析后的表单字段。
 * @param {*} file - 上传文件对象。
 * @returns {*} - 方法执行结果。
 */
function buildRows(fields, file) {
  const start = fields.startDate;
  const end = fields.endDate;
  if (fields.mode === 'full') {
    if (!fields.database) throw new Error('请输入库名');
    const databaseName = normalizeIdentifierText(fields.database);
    const startDate = normalizeDate(start);
    const endDate = normalizeDate(end);
    validateDateRange({ startDate, endDate });
    const rows = listDatabaseTables(databaseName).map((tableName, index) => makeRow({
      id: `full-${index + 1}`,
      databaseName,
      tableName: normalizeTableName(tableName),
      startDate,
      endDate
    }));
    return { rows, configPath: writeTaskConfig(rows, 'full') };
  }

  const items = readTabularFile(file);
  if (!items.length) throw new Error('清单为空或无法识别表头');

  if (fields.mode === 'view') {
    return buildRowsFromViewScript(items, fields);
  }

  if (fields.mode === 'view-source') {
    return buildViewSourceInputRows(items);
  }

  if (fields.mode === 'count') {
    const rows = items.filter((item) => item.tableName).map((item, index) => {
      const startDate = normalizeDate(item.startDate, start);
      const endDate = normalizeDate(item.endDate, end);
      return validateListRowDate(makeRow({
        id: `count-${index + 1}`,
        databaseName: normalizeIdentifierText(item.databaseName),
        tableName: normalizeTableName(item.tableName),
        startDate,
        endDate
      }));
    });
    if (!rows.length) throw new Error('数据量查询清单中未识别到表名');
    return { rows, configPath: writeTaskConfig(rows, 'count-input') };
  }

  const rows = items.filter((item) => item.tableName).map((item, index) => {
    const startDate = normalizeDate(item.startDate, start);
    const endDate = normalizeDate(item.endDate, end);
    return validateListRowDate(makeRow({
      id: `${fields.mode === 'package' ? 'package' : 'source'}-${index + 1}`,
      databaseName: normalizeIdentifierText(item.databaseName),
      tableName: normalizeTableName(item.tableName),
      startDate,
      endDate
    }));
  });
  return { rows, configPath: writeTaskConfig(rows, fields.mode === 'package' ? 'package' : 'source') };
}

/**
 * 方法说明：创建带默认状态和进度的标准任务行。
 * @param {*} row - 当前任务行对象。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：判断指定恢复方式是否应使用模拟执行。
 * @param {*} restoreMode - 恢复方式。
 * @returns {*} - 方法执行结果。
 */
function isDryRun(restoreMode) {
  return !isExecutionEnabled();
}

/**
 * 方法说明：生成模拟执行的原因说明。
 * @param {*} restoreMode - 恢复方式。
 * @returns {*} - 方法执行结果。
 */
function getDryRunReason(restoreMode) {
  if (!isExecutionEnabled()) return '未开启 RECOVERY_EXECUTE=1，进入 dry-run 流程。';
  return '已开启真实 Node 后端执行。';
}

function sendJob(job, payload = {}) {
  job.updatedAt = Date.now();
  if (['completed', 'failed', 'canceled'].includes(job.status) && !job.finishedAt) {
    job.finishedAt = job.updatedAt;
  }
  const data = JSON.stringify({
    id: job.id,
    status: job.status,
    paused: Boolean(job.paused),
    rows: job.rows,
    logs: job.logs.slice(-80),
    summary: zeroCountSummary(job.summary || []),
    summaryTotal: job.summary?.length || 0,
    summaryZeroTotal: zeroCountSummary(job.summary || []).length,
    summaryFile: job.summaryFile ? { fileName: job.summaryFile.fileName, url: job.summaryFile.url } : null,
    countStatus: job.countStatus || 'idle',
    countPhase: job.countPhase || 'idle',
    countProgress: job.countProgress || 0,
    countText: job.countText || '',
    countSkipped: job.countSkipped || 0,
    ...payload
  });
  for (const subscriber of job.subscribers) subscriber.write(`data: ${data}\n\n`);
}

/**
 * 方法说明：等待指定毫秒数后继续执行。
 * @param {*} ms - 等待毫秒数。
 * @returns {*} - 方法执行结果。
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 方法说明：创建并初始化一个后台任务对象。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
function createJob(rows) {
  jobSequence += 1;
  const createdAt = Date.now();
  return {
    id: `job-${createdAt}-${jobSequence}`,
    createdAt,
    updatedAt: createdAt,
    finishedAt: null,
    status: 'running',
    rows: rows.map((row) => {
      const invalid = row.status === 'failed';
      return makeRow({
        ...row,
        progress: invalid ? Math.max(Number(row.progress || 0), 100) : 0,
        status: invalid ? 'failed' : 'pending',
        statusText: invalid ? (row.statusText || statusText.failed) : statusText.pending
      });
    }),
    logs: [],
    summary: [],
    countStatus: 'idle',
    countPhase: 'idle',
    countProgress: 0,
    countText: '',
    countSkipped: 0,
    paused: false,
    cancelRequested: false,
    currentChild: null,
    currentChildren: new Set(),
    subscribers: new Set()
  };
}

/**
 * 方法说明：返回任务中可参与恢复的有效行。
 * @param {*} job - 当前后台任务对象。
 * @returns {*} - 方法执行结果。
 */
function getRestoreRows(job) {
  return job.restoreRows || job.rows;
}

/**
 * 方法说明：创建带有终止标记的任务取消错误。
 * @param {*} message - 需要展示或写入日志的消息。
 * @returns {*} - 方法执行结果。
 */
function makeCanceledError(message = '任务已终止') {
  const error = new Error(message);
  error.code = 'JOB_CANCELED';
  return error;
}

/**
 * 方法说明：检查任务未被终止且仍允许继续执行。
 * @param {*} job - 当前后台任务对象。
 * @returns {*} - 方法执行结果。
 */
function assertJobActive(job) {
  if (job?.cancelRequested) throw makeCanceledError();
}

/**
 * 方法说明：任务暂停时等待继续或终止信号。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function waitIfPaused(job) {
  if (!job) return;
  while (job.paused && !job.cancelRequested) {
    await sleep(500);
  }
  assertJobActive(job);
}

/**
 * 方法说明：在关键步骤检查暂停、终止和子进程状态。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function jobCheckpoint(job) {
  assertJobActive(job);
  await waitIfPaused(job);
}

/**
 * 方法说明：向后台 Shell 子进程发送终止信号。
 * @param {*} child - 后台子进程对象。
 * @param {*} signal - 进程终止信号。
 * @returns {*} - 方法执行结果。
 */
function signalChildProcess(child, signal) {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 方法说明：登记任务关联的后台子进程。
 * @param {*} job - 当前后台任务对象。
 * @param {*} child - 后台子进程对象。
 * @returns {*} - 方法执行结果。
 */
function registerJobChild(job, child) {
  if (!job) return;
  if (!job.currentChildren) job.currentChildren = new Set();
  job.currentChildren.add(child);
  job.currentChild = child;
}

/**
 * 方法说明：移除任务关联的后台子进程。
 * @param {*} job - 当前后台任务对象。
 * @param {*} child - 后台子进程对象。
 * @returns {*} - 方法执行结果。
 */
function unregisterJobChild(job, child) {
  if (!job) return;
  job.currentChildren?.delete(child);
  if (job.currentChild === child) {
    job.currentChild = [...(job.currentChildren || [])].pop() || null;
  }
}

/**
 * 方法说明：返回任务当前关联的子进程集合。
 * @param {*} job - 当前后台任务对象。
 * @returns {*} - 方法执行结果。
 */
function getJobChildren(job) {
  if (job?.currentChildren?.size) return [...job.currentChildren];
  return job?.currentChild ? [job.currentChild] : [];
}

/**
 * 方法说明：将执行中的任务行标记为暂停。
 * @param {*} job - 当前后台任务对象。
 * @returns {*} - 方法执行结果。
 */
function markRowsPaused(job) {
  for (const row of job.rows) {
    if (row.status === 'running') row.statusText = statusText.paused;
  }
}

/**
 * 方法说明：将暂停的任务行恢复为执行中。
 * @param {*} job - 当前后台任务对象。
 * @returns {*} - 方法执行结果。
 */
function markRowsResumed(job) {
  for (const row of job.rows) {
    if (row.status === 'running' && row.statusText === statusText.paused) row.statusText = statusText.running;
  }
}

/**
 * 方法说明：终止任务、子进程和未完成的任务行。
 * @param {*} job - 当前后台任务对象。
 * @returns {*} - 方法执行结果。
 */
function markJobCanceled(job) {
  job.status = 'canceled';
  job.cancelRequested = true;
  job.paused = false;
  for (const row of job.rows) {
    if (row.status !== 'completed' && row.status !== 'failed') {
      row.status = 'failed';
      row.statusText = statusText.canceled;
    }
  }
}

function createProgressHeartbeat(job, rows, label, options = {}) {
  const intervalMs = options.intervalMs || 12000;
  const maxProgress = options.maxProgress || 88;
  const step = options.step || 1;
  let tick = 0;
  return setInterval(() => {
    if (job.paused || job.cancelRequested) return;
    tick += 1;
    const targetRows = options.getRows ? options.getRows() : (rows?.length ? rows : job.rows);
    for (const row of targetRows) {
      if (row.status === 'completed' || row.status === 'failed') continue;
      row.status = 'running';
      row.statusText = label;
      const currentProgress = Number(row.progress || 0);
      const nextProgress = Math.min(maxProgress, Math.max(currentProgress, 35) + step);
      row.progress = Math.max(currentProgress, nextProgress);
    }
    job.logs.push(`${label}，已持续 ${Math.round((tick * intervalMs) / 1000)} 秒，请等待 HDFS/Hive 命令返回。`);
    sendJob(job);
  }, intervalMs);
}

/**
 * 方法说明：在进度心跳保护下执行可能耗时的异步操作。
 * @param {*} job - 当前后台任务对象。
 * @param {*} rows - 任务行数组。
 * @param {*} label - 状态或日志标签。
 * @param {*} maxProgress - 该阶段允许达到的最大进度。
 * @param {*} work - 需要执行的异步工作函数。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function runWithProgressHeartbeat(job, rows, label, maxProgress, work) {
  await jobCheckpoint(job);
  const heartbeat = createProgressHeartbeat(job, rows, label, { maxProgress });
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * 方法说明：判断 HDFS put 错误是否适合重试。
 * @param {*} error - 捕获到的错误对象。
 * @returns {*} - 方法执行结果。
 */
function isRetryableHdfsPutError(error) {
  return /LeaseExpiredException|No lease|_COPYING_|AlreadyBeingCreatedException|could only be replicated|DataStreamer Exception/i
    .test(String(error?.message || error || ''));
}

/**
 * 方法说明：按配置重试 HDFS 上传并必要时清理目标目录。
 * @param {*} job - 当前后台任务对象。
 * @param {*} row - 当前任务行对象。
 * @param {*} putArgs - 批量上传命令参数。
 * @param {*} cleanupArgs - 上传失败后的清理命令参数。
 * @param {*} label - 状态或日志标签。
 * @param {*} maxProgress - 该阶段允许达到的最大进度。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function runHdfsPutWithRetry(job, row, putArgs, cleanupArgs, label, maxProgress = 88) {
  const maxAttempts = Number(process.env.HDFS_PUT_RETRY_COUNT || 3);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 1) {
        job.logs.push(`${label} 第 ${attempt}/${maxAttempts} 次重试。`);
        sendJob(job);
      }
      await runWithProgressHeartbeat(job, [row], label, maxProgress, () => (
        runHdfsCommandAsync(putArgs, { job, onData: (chunk) => appendLog(job, chunk) })
      ));
      return;
    } catch (error) {
      if (!isRetryableHdfsPutError(error) || attempt >= maxAttempts) throw error;
      job.logs.push(`${label} 遇到 HDFS 临时写入/租约异常，清理目标后重试：${error.message}`);
      try {
        await runHdfsCommandAsync(cleanupArgs, { job, allowFailure: true, onData: (chunk) => appendLog(job, chunk) });
      } catch (cleanupError) {
        job.logs.push(`重试前清理目标失败，将继续重试：${cleanupError.message}`);
      }
      await sleep(1500 * attempt);
    }
  }
}

/**
 * 方法说明：优先批量上传多个分区，异常时逐分区上传。
 * @param {*} job - 当前后台任务对象。
 * @param {*} row - 当前任务行对象。
 * @param {*} localPartitionDirs - 本地分区目录数组。
 * @param {*} hdfsPartitionDirs - 目标 HDFS 分区目录数组。
 * @param {*} tableRoot - 表的 HDFS 根目录。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function runHdfsBatchPutThenPartitionFallback(job, row, localPartitionDirs, hdfsPartitionDirs, tableRoot) {
  try {
    job.logs.push(`优先批量上传 ${localPartitionDirs.length} 个分区目录 -> ${tableRoot}/`);
    await runWithProgressHeartbeat(job, [row], '批量上传 HDFS 分区中', 88, () => (
      runHdfsCommandAsync(['-put', '-f', ...localPartitionDirs, `${tableRoot}/`], { job, onData: (chunk) => appendLog(job, chunk) })
    ));
    return;
  } catch (error) {
    job.logs.push(`批量上传 HDFS 分区失败，切换为逐日期分区上传：${error.message}`);
    sendJob(job);
  }

  for (let index = 0; index < localPartitionDirs.length; index += 1) {
    await jobCheckpoint(job);
    const localPartitionDir = localPartitionDirs[index];
    const hdfsPartitionDir = hdfsPartitionDirs[index];
    row.statusText = `上传 HDFS 分区 ${index + 1}/${localPartitionDirs.length}`;
    row.progress = Math.max(row.progress || 0, Math.min(88, 52 + Math.round((index / localPartitionDirs.length) * 30)));
    sendJob(job);
    await runHdfsPutWithRetry(
      job,
      row,
      ['-put', '-f', localPartitionDir, `${tableRoot}/`],
      ['-rm', '-r', '-f', hdfsPartitionDir],
      `上传分区 ${path.basename(localPartitionDir)}`,
      88
    );
    row.progress = Math.max(row.progress || 0, Math.min(90, 58 + Math.round(((index + 1) / localPartitionDirs.length) * 30)));
    sendJob(job);
  }
}

/**
 * 方法说明：拆分外部命令输出并追加到任务日志。
 * @param {*} job - 当前后台任务对象。
 * @param {*} chunk - 方法输入的 chunk 参数。
 * @returns {*} - 方法执行结果。
 */
function appendLog(job, chunk) {
  const text = chunk.toString('utf8');
  for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    job.logs.push(line);
    updateRowsFromScriptLine(job, line);
  }
  sendJob(job);
}

/**
 * 方法说明：寻找下一个尚未结束的 Shell 任务行。
 * @param {*} job - 当前后台任务对象。
 * @param {*} fromIndex - 方法输入的 fromIndex 参数。
 * @returns {*} - 方法执行结果。
 */
function nextShellRowIndex(job, fromIndex = -1) {
  const shellRows = job.shellRows || getRestoreRows(job);
  const startIndex = Math.max(0, fromIndex + 1);
  for (let index = startIndex; index < shellRows.length; index += 1) {
    if (shellRows[index].status !== 'completed' && shellRows[index].status !== 'failed') return index;
  }
  for (let index = 0; index < startIndex; index += 1) {
    if (shellRows[index].status !== 'completed' && shellRows[index].status !== 'failed') return index;
  }
  return -1;
}

/**
 * 方法说明：选择 Shell 心跳应更新的当前任务行。
 * @param {*} job - 当前后台任务对象。
 * @returns {*} - 方法执行结果。
 */
function getShellHeartbeatRows(job) {
  const shellRows = job.shellRows || getRestoreRows(job);
  const activeIndex = Number.isInteger(job.activeShellRowIndex) ? job.activeShellRowIndex : nextShellRowIndex(job);
  if (activeIndex >= 0 && shellRows[activeIndex]?.status !== 'completed' && shellRows[activeIndex]?.status !== 'failed') {
    return [shellRows[activeIndex]];
  }
  const nextIndex = nextShellRowIndex(job, activeIndex);
  job.activeShellRowIndex = nextIndex;
  return nextIndex >= 0 ? [shellRows[nextIndex]] : [];
}

/**
 * 方法说明：根据 Shell 日志行更新任务行状态和进度。
 * @param {*} job - 当前后台任务对象。
 * @param {*} line - 方法输入的 line 参数。
 * @returns {*} - 方法执行结果。
 */
function updateRowsFromScriptLine(job, line) {
  const shellRows = job.shellRows || getRestoreRows(job);
  const lineNo = Number(/配置文件第\s+(\d+)\s+行/.exec(line)?.[1] || /视图列表第\s+(\d+)\s+行/.exec(line)?.[1]);
  if (!lineNo || !shellRows[lineNo - 1]) return;
  job.activeShellRowIndex = lineNo - 1;
  const row = shellRows[lineNo - 1];
  if (line.includes('处理成功')) {
    row.progress = 100;
    row.status = 'completed';
    row.statusText = statusText.completed;
    job.activeShellRowIndex = nextShellRowIndex(job, lineNo - 1);
  } else if (line.includes('处理失败') || line.includes('错误')) {
    row.progress = Math.max(row.progress || 0, 30);
    row.status = 'failed';
    row.statusText = statusText.failed;
    job.activeShellRowIndex = nextShellRowIndex(job, lineNo - 1);
  } else {
    row.progress = Math.max(row.progress || 0, 35);
    row.status = 'running';
    row.statusText = statusText.running;
  }
}

/**
 * 方法说明：根据恢复方式组装 Shell 备用脚本参数。
 * @param {*} restoreMode - 恢复方式。
 * @param {*} configPath - 任务配置文件路径。
 * @param {*} options - 可选配置对象。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：异步启动 Shell 备用恢复脚本并转发日志。
 * @param {*} job - 当前后台任务对象。
 * @param {*} restoreMode - 恢复方式。
 * @param {*} configPath - 任务配置文件路径。
 * @param {*} options - 可选配置对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function executeRestoreScript(job, restoreMode, configPath, options) {
  const args = getRestoreArgs(restoreMode, configPath, options);
  job.activeShellRowIndex = nextShellRowIndex(job);
  await jobCheckpoint(job);
  await new Promise((resolve, reject) => {
    const childEnv = restoreMode === 'cross' && options.sourceDatabase
      ? { ...process.env, SOURCE_DATABASE: getSourceDatabase(options.sourceDatabase) }
      : process.env;
    const child = spawn('bash', args, { cwd: rootDir, detached: true, env: childEnv });
    registerJobChild(job, child);
    const heartbeat = createProgressHeartbeat(job, [], 'shell 备用方案执行中', {
      maxProgress: 88,
      intervalMs: 10000,
      getRows: () => getShellHeartbeatRows(job)
    });
    child.stdout.on('data', (chunk) => appendLog(job, chunk));
    child.stderr.on('data', (chunk) => appendLog(job, chunk));
    child.on('error', (error) => {
      clearInterval(heartbeat);
      unregisterJobChild(job, child);
      reject(error);
    });
    child.on('exit', (code) => {
      clearInterval(heartbeat);
      unregisterJobChild(job, child);
      if (job.cancelRequested) {
        reject(makeCanceledError());
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(args[0])} 退出码 ${code}`));
    });
  });
}

/**
 * 方法说明：更新单行任务的进度和状态文本。
 * @param {*} job - 当前后台任务对象。
 * @param {*} row - 当前任务行对象。
 * @param {*} progress - 方法输入的 progress 参数。
 * @param {*} text - 状态文本。
 * @returns {*} - 方法执行结果。
 */
function markRowProgress(job, row, progress, text = statusText.running) {
  row.status = 'running';
  row.statusText = text;
  row.progress = Math.max(row.progress || 0, progress);
  sendJob(job);
}

/**
 * 方法说明：将单行任务标记为完成并发送状态。
 * @param {*} job - 当前后台任务对象。
 * @param {*} row - 当前任务行对象。
 * @returns {*} - 方法执行结果。
 */
function markRowCompleted(job, row) {
  row.progress = 100;
  row.status = 'completed';
  row.statusText = statusText.completed;
  sendJob(job);
}

/**
 * 方法说明：记录单行错误并跳过当前行继续后续任务。
 * @param {*} job - 当前后台任务对象。
 * @param {*} row - 当前任务行对象。
 * @param {*} error - 捕获到的错误对象。
 * @param {*} actionLabel - 任务类型或日志动作名称。
 * @returns {*} - 方法执行结果。
 */
function markRowFailedAndContinue(job, row, error, actionLabel = '恢复') {
  if (error?.code === 'JOB_CANCELED') throw error;
  row.progress = Math.max(Number(row.progress || 0), 30);
  row.status = 'failed';
  row.statusText = statusText.failed;
  job.logs.push(`${actionLabel}任务失败，已跳过 ${row.databaseName}.${row.tableName}，继续处理后续任务：${error.message}`);
  sendJob(job);
}

/**
 * 方法说明：确定跨库恢复目标库并规范化清单行。
 * @param {*} rows - 任务行数组。
 * @param {*} targetDatabase - 目标数据库名称。
 * @returns {*} - 方法执行结果。
 */
function effectiveCrossRows(rows, targetDatabase) {
  const normalizedTargetDatabase = normalizeIdentifierText(targetDatabase);
  return rows.map((row) => ({
    ...row,
    databaseName: normalizeIdentifierText(row.databaseName) || normalizedTargetDatabase || '',
    tableName: normalizeTableName(row.tableName)
  }));
}

/**
 * 方法说明：一次查询恢复清单涉及的分区信息和表路径。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
function buildTableMetadata(rows) {
  const partitionedTables = queryPartitionedTables(rows);
  const tableLocations = getTableLocations(rows);
  return { partitionedTables, tableLocations };
}

/**
 * 方法说明：从批量元数据缓存中读取指定表路径。
 * @param {*} metadata - 方法输入的 metadata 参数。
 * @param {*} row - 当前任务行对象。
 * @param {*} databaseName - 数据库名称。
 * @returns {*} - 方法执行结果。
 */
function getMetadataLocation(metadata, row, databaseName = row.databaseName) {
  const key = `${databaseName}.${row.tableName}`;
  const tablePath = metadata.tableLocations.get(key);
  if (!tablePath) throw new Error(`未查询到表 HDFS 路径：${key}`);
  validateHdfsTablePath(tablePath);
  return tablePath;
}

/**
 * 方法说明：按配置分区字段复制本地数据到中转目录。
 * @param {*} row - 当前任务行对象。
 * @param {*} sourceRoot - 本地源根目录。
 * @param {*} stageRoot - 本地中转根目录。
 * @param {*} job - 当前后台任务对象。
 * @returns {*} - 方法执行结果。
 */
function copyLocalPartitionsToStage(row, sourceRoot, stageRoot, job) {
  const partitionColumn = getPartitionColumn();
  const preparedDates = [];
  const sourceBase = ensureLocalDirectory(sourceRoot, '本地源根目录');
  const stageBase = ensureWritableRootDirectory(stageRoot, '本地中转目录');
  const tableStageDir = path.join(stageBase, row.tableName);

  job.logs.push(`恢复开始前清理本表中转目录：${tableStageDir}`);
  removeLocalDirInsideRoot(stageBase, tableStageDir);

  for (const statDate of enumerateDates(row.startDate, row.endDate)) {
    assertJobActive(job);
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

/**
 * 方法说明：删除目标旧分区、批量上传本地分区并修复元数据。
 * @param {*} row - 当前任务行对象。
 * @param {*} tablePath - Hive 表对应的 HDFS 路径。
 * @param {*} localPartitionDirs - 本地分区目录数组。
 * @param {*} hdfsPartitionDirs - 目标 HDFS 分区目录数组。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function hdfsReplacePartitionsFromLocal(row, tablePath, localPartitionDirs, hdfsPartitionDirs, job) {
  if (!localPartitionDirs.length) return;
  job.logs.push(`删除 ${hdfsPartitionDirs.length} 个旧 HDFS 分区目录`);
  await runWithProgressHeartbeat(job, [row], '删除旧 HDFS 分区中', 70, () => (
    runHdfsCommandAsync(['-rm', '-r', '-f', ...hdfsPartitionDirs], { job, onData: (chunk) => appendLog(job, chunk) })
  ));
  const tableRoot = tablePath.replace(/\/+$/, '');
  await runHdfsCommandAsync(['-mkdir', '-p', tableRoot], { job, onData: (chunk) => appendLog(job, chunk) });
  await runHdfsBatchPutThenPartitionFallback(job, row, localPartitionDirs, hdfsPartitionDirs, tableRoot);
  await repairHdfsPartitionsAsync(job, row, hdfsPartitionDirs, getPartitionColumn(), process.env.PARTITION_REPAIR_MODE);
  job.logs.push(`${row.databaseName}.${row.tableName} 分区修复完成`);
}

/**
 * 方法说明：执行连续日期恢复的 Node 内置流程。
 * @param {*} job - 当前后台任务对象。
 * @param {*} options - 可选配置对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function executeContinuousNative(job, options) {
  const restoreRows = getRestoreRows(job);
  const metadata = buildTableMetadata(restoreRows);
  const partitionColumn = getPartitionColumn();
  const processRow = async (row) => {
    try {
      await jobCheckpoint(job);
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
        return;
      }

      const key = tableKey(row);
      if (!metadata.partitionedTables.has(key)) {
        job.logs.push(`提示：${key} 不是分区表，跳过 HDFS 上传和分区修复`);
        row.progress = 100;
        row.status = 'completed';
        row.statusText = statusText.completed;
        sendJob(job);
        return;
      }

      markRowProgress(job, row, 52, '替换 HDFS 分区');
      const tablePath = getMetadataLocation(metadata, row);
      const localPartitionDirs = preparedDates.map((statDate) => path.join(path.resolve(options.stageRoot), row.tableName, `${partitionColumn}=${statDate}`));
      const hdfsPartitionDirs = preparedDates.map((statDate) => `${tablePath.replace(/\/+$/, '')}/${partitionColumn}=${statDate}`);
      await hdfsReplacePartitionsFromLocal(row, tablePath, localPartitionDirs, hdfsPartitionDirs, job);
      removeLocalDirInsideRoot(options.stageRoot, path.join(options.stageRoot, row.tableName));
      markRowCompleted(job, row);
    } catch (error) {
      markRowFailedAndContinue(job, row, error, '连续时间段恢复');
    }
  };
  await executeRestoreRowsByTable(job, restoreRows, processRow, '连续时间段恢复');
}

/**
 * 方法说明：筛选日期范围内存在且有文件的本地分区。
 * @param {*} row - 当前任务行对象。
 * @param {*} sourceRoot - 本地源根目录。
 * @param {*} job - 当前后台任务对象。
 * @returns {*} - 方法执行结果。
 */
function getValidLocalPartitionDirs(row, sourceRoot, job) {
  const partitionColumn = getPartitionColumn();
  const sourceBase = ensureLocalDirectory(sourceRoot, '分区表源根目录');
  const sourcePartitions = [];
  const hdfsDates = [];
  for (const statDate of enumerateDates(row.startDate, row.endDate)) {
    assertJobActive(job);
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

/**
 * 方法说明：执行单日期恢复并兼容分区表和非分区表。
 * @param {*} job - 当前后台任务对象。
 * @param {*} options - 可选配置对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function executeSingleNative(job, options) {
  const restoreRows = getRestoreRows(job);
  const metadata = buildTableMetadata(restoreRows);
  const partitionColumn = getPartitionColumn();
  ensureLocalDirectory(options.sourceRoot, '分区表源根目录');
  ensureLocalDirectory(options.nonPartitionSourceRoot, '非分区表源根目录');

  const processRow = async (row) => {
    try {
      await jobCheckpoint(job);
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
          return;
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
          return;
        }
        markRowProgress(job, row, 52, '上传非分区表数据');
        job.logs.push(`删除非分区表旧 HDFS 数据：${tablePath.replace(/\/+$/, '')}/*`);
        await runWithProgressHeartbeat(job, [row], '删除非分区表旧数据中', 70, () => (
          runHdfsCommandAsync(['-rm', '-r', '-f', `${tablePath.replace(/\/+$/, '')}/*`], { job, onData: (chunk) => appendLog(job, chunk) })
        ));
        const tableRoot = tablePath.replace(/\/+$/, '');
        await runHdfsCommandAsync(['-mkdir', '-p', tableRoot], { job, onData: (chunk) => appendLog(job, chunk) });
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
      markRowCompleted(job, row);
    } catch (error) {
      markRowFailedAndContinue(job, row, error, '单日期恢复');
    }
  };
  await executeRestoreRowsByTable(job, restoreRows, processRow, '单日期恢复');
}

async function executeCrossNative(job, options = {}) {
  const sourceDatabase = getSourceDatabase(options.sourceDatabase);
  const partitionColumn = getPartitionColumn();
  const targetRows = getRestoreRows(job);
  const partitionedCache = new Map();
  const locationCache = new Map();

  const isPartitionedCached = (databaseName, tableName) => {
    const key = `${databaseName}.${tableName}`;
    if (!partitionedCache.has(key)) partitionedCache.set(key, isPartitionedTable(databaseName, tableName));
    return partitionedCache.get(key);
  };

  const getLocationCached = (databaseName, tableName) => {
    const key = `${databaseName}.${tableName}`;
    if (!locationCache.has(key)) locationCache.set(key, getTableLocation(databaseName, tableName));
    return locationCache.get(key);
  };

  job.logs.push(`跨库恢复源库：${sourceDatabase}；目标库优先使用清单库名，清单为空时使用页面跨库目标库。`);

  const processRow = async (row) => {
    try {
      await jobCheckpoint(job);
      validateIdentifier(row.databaseName, '目标库名');
      validateIdentifier(row.tableName, '表名');
      validateDateRange(row);
      if (row.databaseName === sourceDatabase) throw new Error(`目标库与源库相同，拒绝覆盖源表：${sourceDatabase}.${row.tableName}`);
      markRowProgress(job, row, 18, '准备跨库分区');

      const sourceKey = `${sourceDatabase}.${row.tableName}`;
      const targetKey = tableKey(row);
      job.logs.push(`跨库目标映射：${sourceKey} -> ${targetKey}`);
      if (!isPartitionedCached(sourceDatabase, row.tableName)) throw new Error(`${sourceKey} 不是分区表，无法跨库按日期复制`);
      if (!isPartitionedCached(row.databaseName, row.tableName)) throw new Error(`${targetKey} 不是分区表，无法跨库按日期复制`);

      const sourceTablePath = getLocationCached(sourceDatabase, row.tableName);
      const targetTablePath = getLocationCached(row.databaseName, row.tableName);
      if (!sourceTablePath || !targetTablePath) throw new Error(`未查询到跨库表路径：${sourceKey} -> ${targetKey}`);
      validateHdfsTablePath(sourceTablePath);
      validateHdfsTablePath(targetTablePath);
      if (sourceTablePath === targetTablePath) throw new Error(`源表和目标表 HDFS 路径相同，拒绝执行：${sourceTablePath}`);

      const sourcePartitions = [];
      const targetPartitions = [];
      const dates = enumerateDates(row.startDate, row.endDate);
      const requestedTargetPartitions = dates.map((statDate) => `${targetTablePath.replace(/\/+$/, '')}/${partitionColumn}=${statDate}`);
      const listedDates = await listHdfsPartitionDatesAsync(sourceTablePath, partitionColumn, job);
      let availableDates = listedDates
        ? new Set(dates.filter((statDate) => listedDates.has(statDate)))
        : null;
      const shouldFallbackToDateCheck = !availableDates || (dates.length > 0 && availableDates.size === 0);
      if (!shouldFallbackToDateCheck) {
        job.logs.push(`批量检查源分区完成：日期范围 ${dates.length} 天，可复制 ${availableDates.size} 天`);
      } else {
        job.logs.push(availableDates
          ? '批量分区列表未命中日期范围，回退逐日期检查。'
          : '批量检查源分区未返回可解析结果，回退逐日期检查。');
        availableDates = new Set();
        for (const statDate of dates) {
          await jobCheckpoint(job);
          const sourcePartition = `${sourceTablePath.replace(/\/+$/, '')}/${partitionColumn}=${statDate}`;
          if (hdfsTestDir(sourcePartition)) availableDates.add(statDate);
          else job.logs.push(`警告：源分区目录不存在，跳过日期 ${statDate}：${sourcePartition}`);
        }
        job.logs.push(`逐日期检查源分区完成：日期范围 ${dates.length} 天，可复制 ${availableDates.size} 天`);
      }
      for (const statDate of dates) {
        if (!availableDates.has(statDate)) continue;
        sourcePartitions.push(`${sourceTablePath.replace(/\/+$/, '')}/${partitionColumn}=${statDate}`);
        targetPartitions.push(`${targetTablePath.replace(/\/+$/, '')}/${partitionColumn}=${statDate}`);
      }

      if (!sourcePartitions.length) {
        job.logs.push(`警告：${sourceKey} 在指定日期范围内没有可复制的源分区，先清理目标日期范围内的旧分区`);
        await runWithProgressHeartbeat(job, [row], '清理目标旧分区中', 70, () => (
          runHdfsCommandAsync(['-rm', '-r', '-f', ...requestedTargetPartitions], {
            job,
            onData: (chunk) => appendLog(job, chunk)
          })
        ));
        row.progress = 100;
        row.status = 'completed';
        row.statusText = statusText.completed;
        sendJob(job);
        return;
      }

      markRowProgress(job, row, 52, '复制跨库分区');
      await runWithProgressHeartbeat(job, [row], '删除目标日期范围旧分区中', 70, () => (
        runHdfsCommandAsync(['-rm', '-r', '-f', ...requestedTargetPartitions], {
          job,
          onData: (chunk) => appendLog(job, chunk)
        })
      ));
      const targetTableRoot = targetTablePath.replace(/\/+$/, '');
      await runHdfsCommandAsync(['-mkdir', '-p', targetTableRoot], { job, onData: (chunk) => appendLog(job, chunk) });
      await copyCrossPartitionsAsync(job, row, sourcePartitions, targetPartitions, targetTableRoot);
  await repairHdfsPartitionsAsync(job, row, targetPartitions, partitionColumn, process.env.CROSS_REPAIR_MODE);
      markRowCompleted(job, row);
    } catch (error) {
      markRowFailedAndContinue(job, row, error, '跨库数据恢复');
    }
  };

  const groupsByTarget = new Map();
  for (const row of targetRows) {
    const key = `${row.databaseName || ''}.${row.tableName || ''}`;
    if (!groupsByTarget.has(key)) groupsByTarget.set(key, []);
    groupsByTarget.get(key).push(row);
  }
  const groups = [...groupsByTarget.values()];
  const concurrency = Math.min(getCrossTableConcurrency(), groups.length || 1);
  job.logs.push(`跨库恢复启用 ${concurrency} 路表级并发，同一目标表内任务保持串行。`);
  sendJob(job);
  let nextGroupIndex = 0;
  /**
   * 方法说明：从共享任务索引中领取下一组任务并执行该组任务。
   * @returns {Promise<*>} - 方法执行结果。
   */
  async function worker() {
    while (true) {
      const groupIndex = nextGroupIndex;
      nextGroupIndex += 1;
      if (groupIndex >= groups.length) return;
      for (const row of groups[groupIndex]) await processRow(row);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

/**
 * 方法说明：按恢复方式分派到对应 Node 内置执行器。
 * @param {*} job - 当前后台任务对象。
 * @param {*} restoreMode - 恢复方式。
 * @param {*} options - 可选配置对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function executeRestoreNative(job, restoreMode, options) {
  if (restoreMode === 'continuous') return executeContinuousNative(job, options);
  if (restoreMode === 'single') return executeSingleNative(job, options);
  if (restoreMode === 'cross') return executeCrossNative(job, options);
  throw new Error(`未知恢复方式：${restoreMode}`);
}

/**
 * 方法说明：判断 Node 错误是否允许切换 Shell 备用方案。
 * @param {*} error - 捕获到的错误对象。
 * @returns {*} - 方法执行结果。
 */
function shouldFallbackToShell(error) {
  const message = String(error?.message || error || '');
  return !/(目标库与源库相同|日期范围不合法|开始日期晚于|不合法|不是分区表|无法跨库|未查询到表路径|无法判断|源表和目标表 HDFS 路径相同)/.test(message);
}

/**
 * 方法说明：执行 Node 恢复，失败后按条件切换 Shell。
 * @param {*} job - 当前后台任务对象。
 * @param {*} restoreMode - 恢复方式。
 * @param {*} configPath - 任务配置文件路径。
 * @param {*} options - 可选配置对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function executeRestoreNativeWithShellFallback(job, restoreMode, configPath, options) {
  try {
    job.logs.push('开始执行 Node 后端恢复逻辑。');
    sendJob(job);
    await executeRestoreNative(job, restoreMode, options);
    job.logs.push('Node 后端恢复逻辑执行完成。');
  } catch (nativeError) {
    if (!shouldFallbackToShell(nativeError)) {
      job.logs.push(`Node 后端恢复校验失败，未调用 shell 备用方案：${nativeError.message}`);
      throw nativeError;
    }
    job.logs.push(`Node 后端恢复失败，准备调用 shell 备用方案：${nativeError.message}`);
    sendJob(job);
    await executeRestoreScript(job, restoreMode, configPath, options);
    job.logs.push('shell 备用方案执行完成。');
  }
}

/**
 * 方法说明：在 dry-run 模式生成全表模拟数据量。
 * @param {*} row - 当前任务行对象。
 * @returns {*} - 方法执行结果。
 */
function fallbackCount(row) {
  const seed = `${row.databaseName}.${row.tableName}.${row.startDate}.${row.endDate}`;
  return [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) * 17;
}

/**
 * 方法说明：在 dry-run 模式生成单日期模拟数据量。
 * @param {*} row - 当前任务行对象。
 * @param {*} statDate - 日期分区值。
 * @returns {*} - 方法执行结果。
 */
function fallbackCountForDate(row, statDate) {
  const seed = `${row.databaseName}.${row.tableName}.${statDate}`;
  return [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) * 7;
}

/**
 * 方法说明：根据日期和偏移天数计算新日期。
 * @param {*} dateText - 方法输入的 dateText 参数。
 * @param {*} days - 方法输入的 days 参数。
 * @returns {*} - 方法执行结果。
 */
function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * 方法说明：枚举开始日期到结束日期之间的所有日期。
 * @param {*} startDate - 开始日期。
 * @param {*} endDate - 结束日期。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：构造单表单日期的数据量统计行。
 * @param {*} row - 当前任务行对象。
 * @param {*} statDate - 日期分区值。
 * @param {*} count - 数据量或计数值。
 * @param {*} index - 当前数组下标。
 * @returns {*} - 方法执行结果。
 */
function makeSummaryItem(row, statDate, count, index) {
  return {
    id: `${row.id || `${row.databaseName}.${row.tableName}`}-${statDate}-${index}`,
    viewName: row.viewName || '',
    databaseName: row.databaseName || '',
    tableName: row.tableName || '',
    statDate,
    count: count == null || count === ''
      ? null
      : Number.isFinite(Number(count)) ? Number(count) : 0,
    queryStatus: '查询成功',
    queryError: ''
  };
}

/**
 * 方法说明：筛选数据量为零的日期分区结果。
 * @param {*} summary - 数据量统计结果数组。
 * @returns {*} - 方法执行结果。
 */
function zeroCountSummary(summary) {
  return summary.filter((item) => item.count != null && Number(item.count) === 0);
}

/**
 * 方法说明：为失败或跳过的恢复行生成回查结果。
 * @param {*} row - 当前任务行对象。
 * @param {*} error - 捕获到的错误对象。
 * @param {*} index - 当前数组下标。
 * @returns {*} - 方法执行结果。
 */
function makeSkippedSummaryItems(row, error, index) {
  const dates = enumerateDates(row.startDate, row.endDate);
  const statDates = dates.length ? dates : ['ALL'];
  return statDates.map((statDate, dateIndex) => ({
    ...makeSummaryItem(row, statDate, null, `${index}-${dateIndex}`),
    queryStatus: '已跳过',
    queryError: error
  }));
}

/**
 * 方法说明：将数据量回查明细写入结果 Excel。
 * @param {*} job - 当前后台任务对象。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：统一更新数据量查询任务状态和总体进度。
 * @param {*} job - 当前后台任务对象。
 * @param {*} status - 方法输入的 status 参数。
 * @param {*} progress - 方法输入的 progress 参数。
 * @param {*} text - 状态文本。
 * @param {*} phase - 查询阶段，用于区分查询、汇总和最终状态。
 * @returns {*} - 方法执行结果。
 */
function setCountProgress(job, status, progress, text, phase = '') {
  job.countStatus = status;
  job.countPhase = phase || (
    status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'canceled' ? 'canceled' : 'querying'
  );
  const nextProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  const terminal = status === 'completed' || status === 'failed' || status === 'canceled';
  job.countProgress = terminal ? 100 : Math.max(job.countProgress || 0, nextProgress);
  job.countText = text;
  sendJob(job);
}

/**
 * 方法说明：根据查询方式构造数据量查询对象。
 * @param {*} inputRows - 标准化后的输入行数组。
 * @param {*} queryMode - 数据量查询方式。
 * @returns {*} - 方法执行结果。
 */
function buildCountQueryRows(inputRows, queryMode) {
  if (queryMode === 'view-count') {
    const viewDatabase = getViewDatabase();
    const items = inputRows.map((row) => ({
      viewName: normalizeIdentifierText(row.tableName).includes('.')
        ? normalizeIdentifierText(row.tableName)
        : `${normalizeIdentifierText(row.databaseName) || viewDatabase}.${normalizeIdentifierText(row.tableName)}`,
      startDate: row.startDate,
      endDate: row.endDate
    }));
    return buildRowsFromViewScript(items, { startDate: '', endDate: '' });
  }

  if (queryMode === 'source-count') {
    const rows = inputRows.map((row, index) => {
      const databaseName = normalizeIdentifierText(row.databaseName);
      const tableName = normalizeIdentifierText(row.tableName);
      if (!databaseName) throw new Error(`贴源表数据量查询第 ${index + 1} 行缺少库名`);
      validateIdentifier(databaseName, '库名');
      validateIdentifier(tableName, '表名');
      validateDateRange(row);
      return makeRow({
        ...row,
        id: `count-source-${index + 1}`,
        databaseName,
        tableName
      });
    });
    return { rows, configPath: writeTaskConfig(rows, 'count-source') };
  }

  throw new Error(`未知数据量查询方式：${queryMode}`);
}

/**
 * 方法说明：异步构造查询对象并解析视图源表。
 * @param {*} inputRows - 标准化后的输入行数组。
 * @param {*} queryMode - 数据量查询方式。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function buildCountQueryRowsAsync(inputRows, queryMode, job) {
  if (queryMode !== 'view-count' || !isExecutionEnabled()) {
    return buildCountQueryRows(inputRows, queryMode);
  }

  const viewDatabase = getViewDatabase();
  const items = inputRows.map((row) => ({
    viewName: normalizeIdentifierText(row.tableName).includes('.')
      ? normalizeIdentifierText(row.tableName)
      : `${normalizeIdentifierText(row.databaseName) || viewDatabase}.${normalizeIdentifierText(row.tableName)}`,
    startDate: row.startDate,
    endDate: row.endDate
  }));
  const inputPath = path.join(generatedDir, `views-count-${Date.now()}.txt`);
  const input = items
    .filter((item) => item.viewName)
    .map((item) => [normalizeViewName(item.viewName), normalizeDate(item.startDate), normalizeDate(item.endDate)].join(' '))
    .join('\n');
  fs.writeFileSync(inputPath, `${input}\n`);
  return buildRowsFromViewNativeAsync(items, { startDate: '', endDate: '' }, inputPath, job);
}

/**
 * 方法说明：为一批表生成大小写不敏感的 SQL 条件。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
function buildTablePredicate(rows) {
  const pairs = new Set(rows.map((row) => `${row.databaseName}.${row.tableName}`));
  return [...pairs].map((pair) => {
    const [databaseName, tableName] = pair.split('.', 2);
    validateIdentifier(databaseName, '库名');
    validateIdentifier(tableName, '表名');
    return `(database_name='${sqlString(databaseName)}' AND table_name='${sqlString(tableName)}')`;
  }).join(' OR ');
}

/**
 * 方法说明：按批次大小拆分表条件以控制 SQL 长度。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
function buildTablePredicateBatches(rows) {
  const uniqueRows = [...new Map(rows.map((row) => [
    `${row.databaseName}.${row.tableName}`,
    { databaseName: row.databaseName, tableName: row.tableName }
  ])).values()];
  const configuredSize = Number.parseInt(process.env.HIVE_METADATA_BATCH_SIZE || '200', 10);
  const batchSize = Number.isInteger(configuredSize) && configuredSize > 0
    ? Math.min(configuredSize, 1000)
    : 200;
  const predicates = [];
  for (let index = 0; index < uniqueRows.length; index += batchSize) {
    predicates.push(buildTablePredicate(uniqueRows.slice(index, index + batchSize)));
  }
  return predicates.filter(Boolean);
}

/**
 * 方法说明：将批量查询 SQL 写入 generated 目录。
 * @param {*} prefix - 方法输入的 prefix 参数。
 * @param {*} statements - 方法输入的 statements 参数。
 * @returns {*} - 方法执行结果。
 */
function writeGeneratedSqlFile(prefix, statements) {
  generatedSqlSequence += 1;
  const sqlPath = path.join(generatedDir, `${prefix}-${Date.now()}-${generatedSqlSequence}.sql`);
  const body = statements
    .filter(Boolean)
    .map((statement) => String(statement).trim().replace(/;+$/, ''))
    .join(';\n');
  fs.writeFileSync(sqlPath, `${body};\n`);
  return sqlPath;
}

/**
 * 方法说明：按配置将任务行拆分为多个批次。
 * @param {*} rows - 任务行数组。
 * @param {*} configuredSize - 方法输入的 configuredSize 参数。
 * @param {*} defaultSize - 方法输入的 defaultSize 参数。
 * @param {*} maxSize - 方法输入的 maxSize 参数。
 * @returns {*} - 方法执行结果。
 */
function splitRowsIntoBatches(rows, configuredSize, defaultSize, maxSize) {
  const batchSize = Number.isInteger(configuredSize) && configuredSize > 0
    ? Math.min(configuredSize, maxSize)
    : defaultSize;
  const batches = [];
  for (let index = 0; index < rows.length; index += batchSize) {
    batches.push(rows.slice(index, index + batchSize));
  }
  return batches;
}

/**
 * 方法说明：读取数据量查询批次大小配置。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
function getCountQueryBatches(rows) {
  const configuredSize = Number.parseInt(process.env.HIVE_COUNT_BATCH_SIZE || '200', 10);
  return splitRowsIntoBatches(rows, configuredSize, 200, 500);
}

/**
 * 方法说明：读取数据量查询并发配置并限制上限。
 * @returns {*} - 方法执行结果。
 */
function getCountQueryConcurrency() {
  const configured = Number.parseInt(process.env.HIVE_COUNT_CONCURRENCY || '4', 10);
  return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 8) : 4;
}

/**
 * 方法说明：并发执行数据量查询批次并汇总失败信息。
 * @param {*} job - 当前后台任务对象。
 * @param {*} batches - 查询批次数组。
 * @param {*} partitionedTables - 分区表键集合。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function executeCountBatchesWithConcurrency(job, batches, partitionedTables) {
  const concurrency = Math.min(getCountQueryConcurrency(), batches.length || 1);
  const results = new Array(batches.length);
  const errors = [];
  let nextIndex = 0;
  let completed = 0;

  job.logs.push(`数据量查询启用受控并发：${concurrency} 个批次同时执行。`);
  sendJob(job);

  /**
   * 方法说明：从共享任务索引中领取下一组任务并执行该组任务。
   * @returns {Promise<*>} - 方法执行结果。
   */
  async function worker() {
    while (true) {
      await jobCheckpoint(job);
      const index = nextIndex;
      nextIndex += 1;
      if (index >= batches.length) return;
      try {
        results[index] = await executeCountBatchAsync(
          job,
          batches[index],
          partitionedTables,
          `数据量查询第 ${index + 1}/${batches.length} 批`
        );
        completed += 1;
        setCountProgress(
          job,
          'running',
          28 + Math.round((completed / batches.length) * 48),
          `数据量查询已完成 ${completed}/${batches.length} 批。`
        );
      } catch (error) {
        errors.push(new Error(`数据量查询第 ${index + 1}/${batches.length} 批最终失败：${error.message}`));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (errors.length) throw errors[0];
  return results;
}

/**
 * 方法说明：构造查询表分区字段的 SQL 语句。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
function buildPartitionMetadataStatements(rows) {
  return buildTablePredicateBatches(rows).map((predicate) => [
    "SELECT concat(database_name,'.',table_name,'|',cast(count(1) as string))",
    'FROM system.partition_keys_all_v',
    `WHERE ${predicate}`,
    'GROUP BY database_name,table_name'
  ].join(' '));
}

/**
 * 方法说明：同步批量查询分区表集合。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
function queryPartitionedTables(rows) {
  const statements = buildPartitionMetadataStatements(rows);
  if (!statements.length) return new Set();
  const sqlPath = writeGeneratedSqlFile('partition-metadata', statements);
  const output = runBeeline(['-f', sqlPath]);
  const partitioned = new Set();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = cleanBeelineLine(rawLine);
    const [tableKey, count] = line.split('|');
    if (tableKey && Number(count) > 0) partitioned.add(tableKey);
  }
  return partitioned;
}

/**
 * 方法说明：异步批量查询分区表集合并记录进度。
 * @param {*} rows - 任务行数组。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function queryPartitionedTablesAsync(rows, job) {
  const statements = buildPartitionMetadataStatements(rows);
  if (!statements.length) return new Set();
  const sqlPath = writeGeneratedSqlFile('partition-metadata', statements);
  job.logs.push(`分区元数据查询已写入 SQL 文件，共 ${statements.length} 个批次：${sqlPath}`);
  sendJob(job);
  const output = await runBeelineAsync(['-f', sqlPath], { job });
  const partitioned = new Set();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = cleanBeelineLine(rawLine);
    const [tableKey, count] = line.split('|');
    if (tableKey && Number(count) > 0) partitioned.add(tableKey);
  }
  return partitioned;
}

/**
 * 方法说明：同步批量查询表的 HDFS 路径。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
function getTableLocations(rows) {
  const predicates = buildTablePredicateBatches(rows);
  if (!predicates.length) return new Map();
  const locationColumn = process.env.TABLE_LOCATION_COLUMN || 'table_location';
  validateIdentifier(locationColumn, '表路径字段名');
  const statements = predicates.map((predicate) => [
    `SELECT concat(database_name,'.',table_name,'|',${locationColumn})`,
    'FROM system.tables_v',
    `WHERE ${predicate}`
  ].join(' '));
  const sqlPath = writeGeneratedSqlFile('table-locations', statements);
  const output = runBeeline(['-f', sqlPath]);
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

/**
 * 方法说明：异步批量查询表的 HDFS 路径并记录进度。
 * @param {*} rows - 任务行数组。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function getTableLocationsAsync(rows, job) {
  const predicates = buildTablePredicateBatches(rows);
  if (!predicates.length) return new Map();
  const locationColumn = process.env.TABLE_LOCATION_COLUMN || 'table_location';
  validateIdentifier(locationColumn, '表路径字段名');
  const statements = predicates.map((predicate) => [
    `SELECT concat(database_name,'.',table_name,'|',${locationColumn})`,
    'FROM system.tables_v',
    `WHERE ${predicate}`
  ].join(' '));
  const sqlPath = writeGeneratedSqlFile('table-locations', statements);
  job.logs.push(`HDFS 表路径查询已写入 SQL 文件，共 ${statements.length} 个批次：${sqlPath}`);
  sendJob(job);
  const output = await runBeelineAsync(['-f', sqlPath], { job });
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

/**
 * 方法说明：校验目标路径始终位于允许的根目录内。
 * @param {*} rootPath - 方法输入的 rootPath 参数。
 * @param {*} targetPath - 方法输入的 targetPath 参数。
 * @returns {*} - 方法执行结果。
 */
function ensureInsideRoot(rootPath, targetPath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`本地打包目录不合法：${resolvedTarget}`);
  }
}

/**
 * 方法说明：异步执行 HDFS get 将数据下载到本地。
 * @param {*} sourcePath - 方法输入的 sourcePath 参数。
 * @param {*} localTargetPath - 方法输入的 localTargetPath 参数。
 * @param {*} packageRoot - 数据文件打包根目录。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function runHdfsGetAsync(sourcePath, localTargetPath, packageRoot, job) {
  ensureInsideRoot(packageRoot, localTargetPath);
  fs.mkdirSync(path.dirname(localTargetPath), { recursive: true });
  if (fs.existsSync(localTargetPath)) fs.rmSync(localTargetPath, { recursive: true, force: true });
  await runHdfsCommandAsync(['-get', sourcePath, localTargetPath], {
    job,
    onData: (chunk) => appendLog(job, chunk)
  });
}

/**
 * 方法说明：根据表类型和日期范围构造打包路径。
 * @param {*} row - 当前任务行对象。
 * @param {*} options - 可选配置对象。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：同步筛选实际存在的 HDFS 打包路径。
 * @param {*} copies - 方法输入的 copies 参数。
 * @param {*} job - 当前后台任务对象。
 * @returns {*} - 方法执行结果。
 */
function filterExistingPackageCopies(copies, job) {
  const available = [];
  for (const copy of copies) {
    // Non-partitioned tables use the table root directly and must still be downloaded.
    if (copy.statDate === 'ALL' || hdfsTestDir(copy.sourcePath)) {
      available.push(copy);
      continue;
    }
    job.logs.push(`提示：HDFS 分区目录不存在，已跳过：${copy.sourcePath}`);
  }
  return available;
}

/**
 * 方法说明：解析 HDFS ls 输出中的目录名称。
 * @param {*} output - 方法输入的 output 参数。
 * @returns {*} - 方法执行结果。
 */
function hdfsListedBasenames(output) {
  const names = new Set();
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const fields = rawLine.trim().split(/\s+/).filter(Boolean);
    if (!fields.length || fields[0] === 'Found') continue;
    const hdfsPath = fields[fields.length - 1].replace(/\/+$/, '');
    const basename = hdfsPath.slice(hdfsPath.lastIndexOf('/') + 1);
    if (basename) names.add(basename);
  }
  return names;
}

/**
 * 方法说明：批量检查并筛选存在的 HDFS 分区目录。
 * @param {*} copies - 方法输入的 copies 参数。
 * @param {*} row - 当前任务行对象。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function filterExistingPackageCopiesAsync(copies, row, job) {
  const partitionCopies = copies.filter((copy) => copy.statDate !== 'ALL');
  if (!partitionCopies.length) return copies;

  const partitionColumn = process.env.PARTITION_COLUMN || 'tx_dt';
  validateIdentifier(partitionColumn, '分区字段名');
  const marker = `/${partitionColumn}=`;
  const markerIndex = partitionCopies[0].sourcePath.indexOf(marker);
  const tableRoot = markerIndex >= 0 ? partitionCopies[0].sourcePath.slice(0, markerIndex) : '';
  if (!tableRoot) return filterExistingPackageCopies(copies, job);

  row.statusText = `批量检查 ${partitionCopies.length} 个 HDFS 分区目录`;
  row.progress = Math.max(row.progress || 0, 18);
  sendJob(job);
  const result = await runHdfsCommandAsync(['-ls', tableRoot], { job, allowFailure: true });
  if (result.status !== 0) {
    job.logs.push(`提示：无法列出 HDFS 表目录，范围内分区将全部跳过：${tableRoot}`);
    return [];
  }

  const existing = hdfsListedBasenames(result.stdout);
  const available = partitionCopies.filter((copy) => {
    const basename = copy.sourcePath.slice(copy.sourcePath.lastIndexOf('/') + 1);
    return existing.has(basename);
  });
  const skipped = partitionCopies.length - available.length;
  job.logs.push(`${row.databaseName}.${row.tableName} 分区目录检查完成：存在 ${available.length} 个，跳过 ${skipped} 个。`);
  return available;
}

/**
 * 方法说明：解析 Node 直连 Hive 返回的分区数据量。
 * @param {*} output - 方法输入的 output 参数。
 * @param {*} rows - 任务行数组。
 * @param {*} partitionedTables - 分区表键集合。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：解析 Shell 数据量查询结果文件。
 * @param {*} outputPath - 输出文件路径。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：同步执行数据量查询并汇总结果。
 * @param {*} rows - 任务行数组。
 * @returns {*} - 方法执行结果。
 */
function queryCountsDirect(rows) {
  const partitionedTables = queryPartitionedTables(rows);
  const summaries = [];
  const sqlPaths = [];
  for (const batchRows of getCountQueryBatches(rows)) {
    const statements = buildCountSqlStatements(batchRows, partitionedTables);
    const sqlPath = writeGeneratedSqlFile('count-direct', statements);
    sqlPaths.push(sqlPath);
    const output = runBeeline(['-f', sqlPath]);
    summaries.push(...parseDirectCountOutput(output, batchRows, partitionedTables));
  }
  return {
    sqlPath: sqlPaths[0] || '',
    batchCount: sqlPaths.length,
    summary: summaries
  };
}

/**
 * 方法说明：构造分区表和非分区表的数据量 SQL。
 * @param {*} rows - 任务行数组。
 * @param {*} partitionedTables - 分区表键集合。
 * @returns {*} - 方法执行结果。
 */
function buildCountSqlStatements(rows, partitionedTables) {
  const partitionColumn = process.env.PARTITION_COLUMN || 'tx_dt';
  validateIdentifier(partitionColumn, '分区字段名');

  return rows.map((row, index) => {
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
}

/**
 * 方法说明：异步执行一批数据量 SQL 并解析结果。
 * @param {*} job - 当前后台任务对象。
 * @param {*} rows - 任务行数组。
 * @param {*} partitionedTables - 分区表键集合。
 * @param {*} label - 状态或日志标签。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function executeCountBatchAsync(job, rows, partitionedTables, label) {
  const statements = buildCountSqlStatements(rows, partitionedTables);
  const sqlPath = writeGeneratedSqlFile('count-direct', statements);
  for (const row of rows) {
    row.status = 'running';
    row.statusText = label;
    row.progress = Math.max(Number(row.progress || 0), 30);
  }
  job.logs.push(`${label}，${rows.length} 张表：${sqlPath}`);
  sendJob(job);

  try {
    const output = await runBeelineAsync(['-f', sqlPath], { job });
    for (const row of rows) {
      row.statusText = '查询完成，正在汇总';
      row.progress = Math.max(Number(row.progress || 0), 90);
    }
    sendJob(job);
    return {
      sqlPaths: [sqlPath],
      summary: parseDirectCountOutput(output, rows, partitionedTables)
    };
  } catch (error) {
    if (rows.length === 1) {
      const row = rows[0];
      const failure = {
        row,
        error: error.message,
        sqlPath
      };
      row.status = 'failed';
      row.statusText = '查询失败（已跳过）';
      row.progress = 100;
      job.logs.push(`${label}单表失败，已跳过：${row.databaseName}.${row.tableName}（${sqlPath}）：${error.message}`);
      sendJob(job);
      return {
        sqlPaths: [sqlPath],
        summary: makeSkippedSummaryItems(row, error.message, 0),
        failures: [failure]
      };
    }

    const middle = Math.ceil(rows.length / 2);
    for (const row of rows) {
      row.statusText = '批次异常，正在拆分重试';
      row.progress = Math.max(Number(row.progress || 0), 45);
    }
    job.logs.push(`${label}执行失败，正在拆分为 ${middle} 张和 ${rows.length - middle} 张表重试。`);
    sendJob(job);
    const left = await executeCountBatchAsync(job, rows.slice(0, middle), partitionedTables, `${label}左半批`);
    const right = await executeCountBatchAsync(job, rows.slice(middle), partitionedTables, `${label}右半批`);
    return {
      sqlPaths: [...left.sqlPaths, ...right.sqlPaths],
      summary: [...left.summary, ...right.summary],
      failures: [...(left.failures || []), ...(right.failures || [])]
    };
  }
}

function createCountProgressHeartbeat(job, label, options = {}) {
  const intervalMs = options.intervalMs || 10000;
  const minProgress = options.minProgress || 35;
  const maxProgress = options.maxProgress || 78;
  const step = options.step || 2;
  const phase = options.phase || 'querying';
  let tick = 0;
  return setInterval(() => {
    if (job.cancelRequested || job.countStatus !== 'running') return;
    tick += 1;
    const nextProgress = Math.min(maxProgress, Math.max(job.countProgress || 0, minProgress) + step);
    job.countPhase = phase;
    job.countProgress = nextProgress;
    job.countText = label;
    job.logs.push(`${label}，已持续 ${Math.round((tick * intervalMs) / 1000)} 秒，请等待 Hive 查询返回。`);
    sendJob(job);
  }, intervalMs);
}

/**
 * 方法说明：异步执行 Node 直连 Hive 的数据量批量查询，并在失败时拆分重试。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function queryCountsDirectAsync(job) {
  const rows = job.countRows || job.rows;
  const heartbeat = createCountProgressHeartbeat(job, '数据量查询执行中', {
    minProgress: 25,
    maxProgress: 78
  });
  try {
    const partitionedTables = await queryPartitionedTablesAsync(rows, job);
    const batches = getCountQueryBatches(rows);
    const summaries = [];
    const sqlPaths = [];
    const failures = [];
    const batchResults = await executeCountBatchesWithConcurrency(job, batches, partitionedTables);
    for (const batchResult of batchResults) {
      sqlPaths.push(...batchResult.sqlPaths);
      summaries.push(...batchResult.summary);
      failures.push(...(batchResult.failures || []));
      if (batchResult.failures?.length) {
        job.countSkipped = (job.countSkipped || 0) + batchResult.failures.length;
        job.logs.push(`批次已跳过 ${batchResult.failures.length} 张异常表，其他表继续完成。`);
        sendJob(job);
      }
    }
    return {
      sqlPath: sqlPaths[0] || '',
      batchCount: sqlPaths.length,
      summary: summaries,
      failures
    };
  } finally {
    clearInterval(heartbeat);
  }
}

async function queryCounts(job, configPath, options = {}) {
  const queryRows = options.rows || job.rows;
  const startText = options.startText || '数据恢复已完成，开始数据量回查。';
  const nodeText = options.nodeText || '正在通过 Node 后端批量查询表和日期分区数据量。';
  const nodeDoneText = options.nodeDoneText || '数据量查询完成，正在生成 Excel 明细。';
  const dryRunText = options.dryRunText || 'dry-run 正在模拟生成分区数据量明细。';
  const dryRunDoneText = options.dryRunDoneText || '模拟数据量明细已生成，正在写入 Excel。';
  const completedText = options.completedText || '数据量回查完成，完整明细已生成。';
  const failedText = options.failedText || '数据量回查失败，请查看执行日志。';
  const startPhase = options.startPhase || 'rechecking';
  const queryPhase = options.queryPhase || 'querying';
  const aggregatePhase = options.aggregatePhase || 'aggregating';
  const dryRunPhase = options.dryRunPhase || 'querying';

  setCountProgress(job, 'running', Math.max(job.countProgress || 0, 5), startText, startPhase);
  if (isExecutionEnabled()) {
    try {
      setCountProgress(job, 'running', Math.max(job.countProgress || 0, 25), nodeText, queryPhase);
      const result = await queryCountsDirectAsync(job);
      setCountProgress(job, 'running', 82, nodeDoneText, aggregatePhase);
      job.summary = result.summary;
      job.countFailures = result.failures || [];
      job.countSkipped = job.countFailures.length;
      writeCountSummaryWorkbook(job);
      if (job.countSkipped) {
        job.logs.push(`Node 后端数据量批量回查完成：共 ${result.batchCount || 1} 个 SQL 批次文件，已跳过 ${job.countSkipped} 张异常表。`);
        setCountProgress(job, 'completed', 100, `数据量查询完成，已跳过 ${job.countSkipped} 张异常表，Excel 明细已生成。`, 'completed');
      } else {
        job.logs.push(`Node 后端数据量批量回查完成：共 ${result.batchCount || 1} 个 SQL 批次文件，首个文件 ${result.sqlPath}`);
        setCountProgress(job, 'completed', 100, completedText, 'completed');
      }
      return true;
    } catch (error) {
      job.logs.push(`Node 后端数据量回查失败：${error.message}`);
      job.summary = [];
      setCountProgress(job, 'failed', 100, failedText, 'failed');
      return false;
    }
  }

  setCountProgress(job, 'running', 35, dryRunText, dryRunPhase);
  job.summary = queryRows.flatMap((row, index) => {
    const dates = enumerateDates(row.startDate, row.endDate);
    if (!dates.length) return [makeSummaryItem(row, 'ALL', fallbackCount(row), index)];
    return dates.map((statDate, dateIndex) => makeSummaryItem(row, statDate, fallbackCountForDate(row, statDate), `${index}-${dateIndex}`));
  });
  setCountProgress(job, 'running', 82, dryRunDoneText, aggregatePhase);
  writeCountSummaryWorkbook(job);
  job.logs.push('dry-run 使用 Node 后端模拟分区数据量明细。');
  setCountProgress(job, 'completed', 100, completedText, 'completed');
  return true;
}

/**
 * 方法说明：运行恢复任务并在完成后触发数据回查。
 * @param {*} job - 当前后台任务对象。
 * @param {*} restoreMode - 恢复方式。
 * @param {*} options - 可选配置对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function runJob(job, restoreMode, options) {
  const dryRun = isDryRun(restoreMode);
  if (restoreMode === 'cross') {
    job.rows = effectiveCrossRows(job.rows, options.targetDatabase);
  }
  job.restoreRows = job.rows.filter((row) => row.status !== 'failed');
  job.shellRows = job.restoreRows;
  const configPath = writeTaskConfig(job.restoreRows, restoreMode, {
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

  for (const row of job.restoreRows) {
    row.status = 'pending';
    row.statusText = statusText.pending;
    row.progress = 0;
  }
  sendJob(job);

  let recoverableRows = [];
  let countSucceeded = true;
  try {
    if (!job.restoreRows.length) {
      job.logs.push('没有通过清单校验的恢复任务，已跳过数据恢复。');
      sendJob(job);
    } else if (dryRun) {
      for (const row of job.restoreRows) {
        await jobCheckpoint(job);
        row.status = 'running';
        row.statusText = statusText.running;
        row.progress = 8;
        sendJob(job);
        job.logs.push(`模拟恢复 ${row.databaseName}.${row.tableName} ${row.startDate} 至 ${row.endDate}`);
        for (const progress of [24, 46, 68, 88]) {
          await jobCheckpoint(job);
          await sleep(260);
          row.progress = progress;
          sendJob(job);
        }
      }
    } else {
      await executeRestoreNativeWithShellFallback(job, restoreMode, configPath, options);
    }
    for (const row of job.restoreRows) {
      if (row.status !== 'failed') {
        row.progress = 100;
        row.status = 'completed';
        row.statusText = statusText.completed;
      }
    }
    sendJob(job);
    await jobCheckpoint(job);
    recoverableRows = job.rows.filter((row) => row.status === 'completed');
    if (recoverableRows.length) {
      // 回查使用独立行对象，避免批量查询状态覆盖恢复列表中的最终状态。
      job.countRows = recoverableRows.map((row) => ({
        ...row,
        status: 'pending',
        statusText: statusText.pending,
        progress: 0
      }));
      try {
        countSucceeded = await queryCounts(job, configPath, {
          rows: job.countRows,
          startText: '恢复完成，开始数据量回查。',
          nodeText: '数据量回查中：正在查询表和日期分区数据量。',
          nodeDoneText: '数据量查询完成，正在汇总回查结果。',
          completedText: '数据量回查完成，正在等待恢复任务最终汇总。',
          failedText: '恢复完成，但数据量回查失败，请查看执行日志。'
        });
      } finally {
        delete job.countRows;
      }
    } else {
      job.logs.push('没有成功完成的恢复任务，已跳过数据量回查。');
      sendJob(job);
    }
    job.logs.push(countSucceeded ? '恢复执行完成，数据量已回查并完成汇总。' : '恢复执行完成，但数据量回查失败，请查看日志。');
  } catch (error) {
    if (error.code === 'JOB_CANCELED') {
      markJobCanceled(job);
      job.logs.push('恢复任务已终止。');
      sendJob(job);
      return;
    }
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
  if (recoverableRows?.length) {
    const skippedText = job.countSkipped ? `，已跳过 ${job.countSkipped} 张异常表` : '';
    const finalCountStatus = job.status === 'failed' ? 'failed' : countSucceeded ? 'completed' : 'failed';
    const finalCountText = job.status === 'failed'
      ? (countSucceeded ? `恢复失败，部分恢复任务失败；数据量回查和汇总已完成${skippedText}。` : '恢复失败，数据量回查也未完成。')
      : (countSucceeded ? `恢复完成，数据量回查和汇总已完成${skippedText}。` : '恢复完成，但数据量回查失败，请查看日志。');
    setCountProgress(job, finalCountStatus, 100, finalCountText, finalCountStatus);
  } else {
    setCountProgress(job, 'failed', 100, '恢复失败，没有可回查的成功任务。', 'failed');
  }
  sendJob(job);
}

/**
 * 方法说明：查询元数据、下载 HDFS 文件并生成打包结果。
 * @param {*} job - 当前后台任务对象。
 * @param {*} options - 可选配置对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
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
      for (const row of job.rows) {
        row.status = 'running';
        row.statusText = '查询分区元数据';
        row.progress = Math.max(row.progress || 0, 10);
      }
      job.logs.push('开始异步查询表分区信息，请等待 Hive 返回。');
      sendJob(job);
      const partitionedTables = await queryPartitionedTablesAsync(job.rows, job);
      job.logs.push(`表分区信息查询完成，共识别 ${partitionedTables.size} 张分区表。`);
      for (const row of job.rows) {
        row.statusText = '查询 HDFS 表路径';
        row.progress = Math.max(row.progress || 0, 14);
      }
      sendJob(job);
      const tableLocations = await getTableLocationsAsync(job.rows, job);
      job.logs.push(`HDFS 表路径查询完成，共获取 ${tableLocations.size} 张表路径。`);
      sendJob(job);

      for (let rowIndex = 0; rowIndex < job.rows.length; rowIndex += 1) {
        const row = job.rows[rowIndex];
        row.status = 'running';
        row.statusText = `准备打包（${rowIndex + 1}/${job.rows.length}）`;
        row.progress = Math.max(row.progress || 0, 16);
        sendJob(job);

        const allCopies = buildPackageCopies(row, {
          packageRoot: options.packageRoot,
          partitionedTables,
          tableLocations
        });
        const copies = await filterExistingPackageCopiesAsync(allCopies, row, job);
        if (copies.length !== allCopies.length) {
          job.logs.push(`${row.databaseName}.${row.tableName} 已跳过 ${allCopies.length - copies.length} 个不存在的 HDFS 分区目录。`);
          sendJob(job);
        }
        if (!copies.length) {
          row.progress = 100;
          row.status = 'completed';
          row.statusText = '指定日期范围没有可打包分区，已跳过';
          sendJob(job);
          continue;
        }
        row.statusText = `打包 ${copies.length} 个路径`;

        for (let index = 0; index < copies.length; index += 1) {
          const copy = copies[index];
          const downloadLabel = copy.statDate === 'ALL' ? '非分区表文件下载中' : `下载分区 ${copy.statDate}`;
          row.statusText = downloadLabel;
          row.progress = Math.max(row.progress || 0, Math.min(94, 20 + Math.round((index / copies.length) * 74)));
          job.logs.push(`开始 ${downloadLabel}：${copy.sourcePath}`);
          sendJob(job);
          await runWithProgressHeartbeat(job, [row], downloadLabel, 96, () => (
            runHdfsGetAsync(copy.sourcePath, copy.localTargetPath, options.packageRoot, job)
          ));
          row.progress = Math.min(96, Math.round(20 + ((index + 1) / copies.length) * 76));
          row.statusText = `已完成 ${index + 1}/${copies.length} 个路径`;
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

/**
 * 方法说明：解析视图源表并生成可下载的 Excel 结果。
 * @param {*} job - 当前后台任务对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function runViewSourceQueryJob(job) {
  const inputRows = job.rows;
  const inputPath = writeViewSourceInputFile(inputRows);
  job.configPath = inputPath;
  job.logs.push(`视图源表查询清单：${inputPath}`);
  sendJob(job);

  try {
    let resultRows;
    if (!isExecutionEnabled()) {
      resultRows = buildViewSourceRowsDryRun(inputRows);
      job.logs.push('未开启 RECOVERY_EXECUTE=1，使用本地视图源表映射 dry-run。');
    } else try {
      job.logs.push('开始通过 Node 后端解析视图源表。');
      sendJob(job);
      resultRows = await buildViewSourceRowsNativeAsync(inputRows, job);
      job.logs.push('Node 后端视图源表查询完成。');
    } catch (nativeError) {
      job.logs.push(`Node 视图源表查询失败，准备调用 shell 备用方案：${nativeError.message}`);
      sendJob(job);
      const outputPath = path.join(generatedDir, `view-source-query-${job.id}.txt`);
      const fallback = runViewSourceScriptFallback(inputPath, outputPath);
      resultRows = fallback.rows;
      const fallbackFailures = nativeError.failures || [];
      const existingKeys = new Set(resultRows.map((row) => `${row.viewName}|${row.databaseName}|${row.tableName}|${row.startDate}|${row.endDate}`));
      for (const failure of fallbackFailures) {
        const row = failure.row;
        const key = `${row.viewName}|${row.databaseName}|${row.tableName}|${row.startDate}|${row.endDate}`;
        if (!existingKeys.has(key)) resultRows.push(row);
      }
      if (fallback.log.trim()) job.logs.push(fallback.log.trim());
      job.logs.push('shell 视图源表查询备用方案执行完成。');
    }

    job.rows = resultRows.map((row) => makeRow({
      ...row,
      progress: 100,
      status: row.status === 'failed' ? 'failed' : 'completed',
      statusText: row.status === 'failed' ? (row.statusText || statusText.failed) : statusText.completed
    }));
    writeViewSourceSummaryWorkbook(job);
    job.status = job.rows.some((row) => row.status === 'failed') ? 'failed' : 'completed';
    job.logs.push(job.status === 'completed'
      ? '视图源表查询完成，Excel 明细已生成。'
      : '视图源表查询完成，存在失败行，失败行已写入 Excel。');
  } catch (error) {
    job.status = 'failed';
    job.logs.push(`视图源表查询任务失败：${error.message}`);
    job.rows = inputRows.map((row) => makeRow({
      ...row,
      progress: 100,
      status: 'failed',
      statusText: statusText.failed,
      error: error.message
    }));
  }
  sendJob(job);
}

/**
 * 方法说明：执行视图或贴源表数据量查询。
 * @param {*} job - 当前后台任务对象。
 * @param {*} queryMode - 数据量查询方式。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function runCountQueryJob(job, queryMode) {
  try {
    job.logs.push(queryMode === 'view-count' ? '开始视图数据量查询，先解析视图源表。' : '开始贴源表数据量查询。');
    sendJob(job);

    setCountProgress(job, 'running', 3, queryMode === 'view-count' ? '正在准备解析视图源表。' : '正在准备数据量查询。');
    const result = await buildCountQueryRowsAsync(job.rows, queryMode, job);
    job.rows = result.rows.map((row) => makeRow({
      ...row,
      status: 'running',
      statusText: '数据量查询中',
      progress: 20
    }));
    job.configPath = result.configPath;
    if (result.fallbackReason) job.logs.push(result.fallbackReason);
    job.logs.push(`数据量查询配置文件：${result.configPath}`);
    sendJob(job);

    const succeeded = await queryCounts(job, result.configPath, {
      startText: '开始数据量查询。',
      nodeText: '正在通过 Node 后端查询表和日期分区数据量。',
      nodeDoneText: '查询完成，正在汇总数据量结果。',
      startPhase: 'querying',
      completedText: '数据量查询完成，Excel 明细已生成。',
      failedText: '数据量查询失败，请查看执行日志。'
    });

    const skippedRowIds = new Set((job.countFailures || []).map((failure) => failure.row?.id));
    for (const row of job.rows) {
      row.progress = 100;
      if (skippedRowIds.has(row.id)) {
        row.status = 'failed';
        row.statusText = '查询失败（已跳过）';
      } else {
        row.status = succeeded ? 'completed' : 'failed';
        row.statusText = succeeded ? statusText.completed : statusText.failed;
      }
    }
    job.status = succeeded ? 'completed' : 'failed';
    job.logs.push(succeeded ? '全部数据量查询任务完成。' : '数据量查询任务结束，存在失败。');
  } catch (error) {
    job.status = 'failed';
    job.logs.push(`数据量查询失败：${error.message}`);
    setCountProgress(job, 'failed', 100, '数据量查询失败，请查看执行日志。');
    for (const row of job.rows) {
      row.status = 'failed';
      row.statusText = statusText.failed;
    }
  }
  sendJob(job);
}

/**
 * 方法说明：处理文件上传、清单解析和对象展示请求。
 * @param {*} req - HTTP 请求对象。
 * @param {*} res - HTTP 响应对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function handleParse(req, res) {
  let uploadedFilePaths = [];
  try {
    const body = await readBody(req);
    const { fields, files } = parseMultipart(body, req.headers['content-type']);
    uploadedFilePaths = Object.values(files).map((file) => file.path).filter(Boolean);
    const { rows, configPath, viewInputPath, fallbackReason } = buildRows(fields, files.file);
    const invalidRows = rows.filter((row) => row.status === 'failed');
    sendJson(res, 200, {
      rows,
      meta: {
        configPath,
        viewInputPath,
        ...getExecutionMeta()
      },
      logs: [
        `已读取 ${rows.length} 个${fields.mode === 'package' ? '打包对象' : fields.mode === 'count' || fields.mode === 'view-source' ? '查询对象' : '恢复对象'}。`,
        ...(invalidRows.length ? [`其中 ${invalidRows.length} 行清单校验失败，后续恢复和数据回查将自动跳过这些行。`] : []),
        fields.mode === 'view'
          ? '已根据视图名解析源表并生成恢复配置。'
          : fields.mode === 'view-source'
            ? '已读取视图源表查询清单，请执行查询。'
          : fields.mode === 'package'
            ? '已生成数据文件打包配置。'
            : fields.mode === 'count'
              ? '已生成数据量查询清单，请选择查询方式。'
              : '已生成恢复配置。',
        ...(fallbackReason ? [fallbackReason] : [])
      ]
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  } finally {
    for (const filePath of uploadedFilePaths) removeManagedFile(filePath, uploadDir);
  }
}

/**
 * 方法说明：校验恢复请求并创建后台恢复任务。
 * @param {*} req - HTTP 请求对象。
 * @param {*} res - HTTP 响应对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function handleRestore(req, res) {
  try {
    const payload = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!Array.isArray(payload.rows) || !payload.rows.length) throw new Error('没有可恢复的行');
    const validRows = payload.rows.filter((row) => row.status !== 'failed');
    const sourceDatabase = payload.restoreMode === 'cross' ? getSourceDatabase(payload.sourceDatabase) : '';
    if (payload.restoreMode === 'cross') {
      const missingTargetDatabaseRows = validRows.filter((row) => !row.databaseName);
      if (missingTargetDatabaseRows.length && !payload.targetDatabase) {
        throw new Error('跨库数据恢复中存在未填写库名的行，请在清单库名列补充目标库，或填写页面跨库目标库作为统一兜底');
      }
    } else if (validRows.some((row) => !row.databaseName)) {
      throw new Error('连续时间段恢复和单日期恢复要求清单中每行必须包含库名');
    }

    const job = createJob(payload.rows);
    jobs.set(job.id, job);
    sendJson(res, 200, { jobId: job.id });
    const sourcePathConfig = resolveSourceRoot(payload.sourceType);
    runJob(job, payload.restoreMode, {
      targetDatabase: payload.targetDatabase,
      sourceDatabase,
      sourceRoot: sourcePathConfig.sourceRoot,
      sourceType: sourcePathConfig.sourceType,
      nonPartitionSourceRoot: sourcePathConfig.nonPartitionSourceRoot,
      stageRoot: sourcePathConfig.stageRoot
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

/**
 * 方法说明：校验打包请求并创建后台打包任务。
 * @param {*} req - HTTP 请求对象。
 * @param {*} res - HTTP 响应对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
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

    const job = createJob(payload.rows);
    jobs.set(job.id, job);
    sendJson(res, 200, { jobId: job.id });
    runPackageJob(job, {
      packageRoot: localPathConfig.packageRoot
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

/**
 * 方法说明：校验数据量查询请求并创建后台查询任务。
 * @param {*} req - HTTP 请求对象。
 * @param {*} res - HTTP 响应对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function handleCountQuery(req, res) {
  try {
    const payload = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!Array.isArray(payload.rows) || !payload.rows.length) throw new Error('没有可查询的行');
    if (!['view-count', 'source-count'].includes(payload.queryMode)) throw new Error('请选择数据量查询方式');
    if (payload.rows.some((row) => !row.tableName || !row.startDate || !row.endDate)) {
      throw new Error('数据量查询要求每行必须包含表名、开始日期和结束日期');
    }
    if (payload.queryMode === 'source-count' && payload.rows.some((row) => !row.databaseName)) {
      throw new Error('贴源表数据量查询要求每行必须包含库名');
    }

    const job = createJob(payload.rows);
    jobs.set(job.id, job);
    sendJson(res, 200, { jobId: job.id });
    setTimeout(() => {
      runCountQueryJob(job, payload.queryMode);
    }, 50);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

/**
 * 方法说明：校验视图源表查询请求并创建后台任务。
 * @param {*} req - HTTP 请求对象。
 * @param {*} res - HTTP 响应对象。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function handleViewSourceQuery(req, res) {
  try {
    const payload = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!Array.isArray(payload.rows) || !payload.rows.length) throw new Error('没有可查询的视图');
    if (payload.rows.some((row) => row.status !== 'failed' && !row.viewName)) {
      throw new Error('视图源表查询要求每行必须包含视图名');
    }
    const job = createJob(payload.rows);
    jobs.set(job.id, job);
    sendJson(res, 200, { jobId: job.id });
    setTimeout(() => {
      runViewSourceQueryJob(job);
    }, 50);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

/**
 * 方法说明：返回恢复清单 Excel 模板。
 * @param {*} req - HTTP 请求对象。
 * @param {*} res - HTTP 响应对象。
 * @returns {*} - 方法执行结果。
 */
function handleTemplateDownload(req, res) {
  const buffer = makeRecoveryTemplateXlsx();
  sendBuffer(res, 200, buffer, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': "attachment; filename=\"recovery-template.xlsx\"; filename*=UTF-8''%E6%81%A2%E5%A4%8D%E6%A8%A1%E7%89%88.xlsx",
    'Cache-Control': 'no-store'
  });
}

/**
 * 方法说明：返回数据量回查明细 Excel。
 * @param {*} req - HTTP 请求对象。
 * @param {*} res - HTTP 响应对象。
 * @param {*} jobId - 任务编号。
 * @returns {*} - 方法执行结果。
 */
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

/**
 * 方法说明：返回视图源表查询明细 Excel。
 * @param {*} req - HTTP 请求对象。
 * @param {*} res - HTTP 响应对象。
 * @param {*} jobId - 任务编号。
 * @returns {*} - 方法执行结果。
 */
function handleViewSourceSummaryDownload(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job?.summaryFile || !fs.existsSync(job.summaryFile.filePath)) {
    return sendJson(res, 404, { error: '视图源表查询明细文件不存在或尚未生成' });
  }
  const buffer = fs.readFileSync(job.summaryFile.filePath);
  return sendBuffer(res, 200, buffer, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': "attachment; filename=\"view-source-summary.xlsx\"; filename*=UTF-8''%E8%A7%86%E5%9B%BE%E6%BA%90%E8%A1%A8%E6%9F%A5%E8%AF%A2.xlsx",
    'Cache-Control': 'no-store'
  });
}

/**
 * 方法说明：执行任务暂停、继续或终止控制。
 * @param {*} req - HTTP 请求对象。
 * @param {*} res - HTTP 响应对象。
 * @param {*} jobId - 任务编号。
 * @param {*} action - 任务控制动作。
 * @returns {*} - 方法执行结果。
 */
function handleJobControl(req, res, jobId, action) {
  const job = jobs.get(jobId);
  if (!job) return sendJson(res, 404, { error: '任务不存在或已过期' });
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'canceled') {
    return sendJson(res, 400, { error: '任务已结束，不能继续操作' });
  }

  if (action === 'pause') {
    job.paused = true;
    markRowsPaused(job);
    for (const child of getJobChildren(job)) signalChildProcess(child, 'SIGSTOP');
    job.logs.push('用户已暂停当前任务。');
    sendJob(job);
    return sendJson(res, 200, { ok: true, paused: true });
  }

  if (action === 'resume') {
    job.paused = false;
    markRowsResumed(job);
    for (const child of getJobChildren(job)) signalChildProcess(child, 'SIGCONT');
    job.logs.push('用户已继续当前任务。');
    sendJob(job);
    return sendJson(res, 200, { ok: true, paused: false });
  }

  if (action === 'cancel') {
    markJobCanceled(job);
    for (const child of getJobChildren(job)) {
      signalChildProcess(child, 'SIGTERM');
      signalChildProcess(child, 'SIGCONT');
    }
    job.logs.push('用户已终止当前任务。');
    sendJob(job);
    return sendJson(res, 200, { ok: true, canceled: true });
  }

  return sendJson(res, 400, { error: '未知任务操作' });
}

/**
 * 方法说明：以 SSE 形式持续推送任务状态和日志。
 * @param {*} req - HTTP 请求对象。
 * @param {*} res - HTTP 响应对象。
 * @param {*} jobId - 任务编号。
 * @returns {*} - 方法执行结果。
 */
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
  if ((req.method === 'GET' || req.method === 'HEAD') && /^\/api\/jobs\/[^/]+\/view-source\.xlsx$/.test(url.pathname)) {
    return handleViewSourceSummaryDownload(req, res, url.pathname.split('/')[3]);
  }
  if (req.method === 'POST' && url.pathname === '/api/parse') return handleParse(req, res);
  if (req.method === 'POST' && url.pathname === '/api/restore') return handleRestore(req, res);
  if (req.method === 'POST' && url.pathname === '/api/package') return handlePackage(req, res);
  if (req.method === 'POST' && url.pathname === '/api/count-query') return handleCountQuery(req, res);
  if (req.method === 'POST' && url.pathname === '/api/view-source-query') return handleViewSourceQuery(req, res);
  if (req.method === 'POST' && /^\/api\/jobs\/[^/]+\/(pause|resume|cancel)$/.test(url.pathname)) {
    const [, , , jobId, action] = url.pathname.split('/');
    return handleJobControl(req, res, jobId, action);
  }
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
scheduleStorageCleanup();
