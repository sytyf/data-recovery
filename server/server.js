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

function makeRecoveryTemplateXlsx() {
  const rows = [
    ['视图名', '库名', '源表名', '数据恢复开始日期', '数据恢复结束日期'],
    ['', '', '', '', '']
  ];
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
    <sheet name="恢复清单模板" sheetId="1" r:id="rId1"/>
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

function normalizeDate(value, fallback) {
  return String(value || fallback || '').slice(0, 10);
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
    runScriptSync('view_to_source_tables.sh', [inputPath, outputPath]);
    const rows = parseTaskConfig(outputPath);
    if (!rows.length) throw new Error('视图解析脚本未输出源表');
    return { rows, configPath: outputPath, viewInputPath: inputPath };
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
  return !isExecutionEnabled() || !fs.existsSync(path.join(scriptDir, scriptMap[restoreMode]));
}

function getDryRunReason(restoreMode) {
  if (!isExecutionEnabled()) return '未开启 RECOVERY_EXECUTE=1，进入 dry-run 流程。';
  const scriptName = scriptMap[restoreMode];
  if (!scriptName || !fs.existsSync(path.join(scriptDir, scriptName))) {
    return `恢复脚本不存在或未配置：${scriptName || restoreMode}，进入 dry-run 流程。`;
  }
  return '';
}

function sendJob(job, payload = {}) {
  const data = JSON.stringify({
    id: job.id,
    status: job.status,
    rows: job.rows,
    logs: job.logs.slice(-80),
    summary: job.summary,
    ...payload
  });
  for (const subscriber of job.subscribers) subscriber.write(`data: ${data}\n\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    child.stdout.on('data', (chunk) => appendLog(job, chunk));
    child.stderr.on('data', (chunk) => appendLog(job, chunk));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(args[0])} 退出码 ${code}`));
    });
  });
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

  const hdfsBin = process.env.HDFS_BIN || 'hdfs';
  const result = spawnSync(hdfsBin, ['dfs', '-get', sourcePath, localTargetPath], {
    cwd: rootDir,
    encoding: 'utf8',
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(`hdfs dfs -get 执行失败：${result.stderr || result.stdout || `退出码 ${result.status}`}`);
  }
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

async function queryCounts(job) {
  if (isExecutionEnabled()) {
    try {
      const result = queryCountsDirect(job.rows);
      job.summary = result.summary;
      job.logs.push(`Node 后端数据量批量回查完成：${result.sqlPath}`);
      return true;
    } catch (error) {
      job.summary = [];
      job.logs.push(`Node 后端数据量回查失败：${error.message}`);
      return false;
    }
  }

  job.summary = job.rows.flatMap((row, index) => {
    const dates = enumerateDates(row.startDate, row.endDate);
    if (!dates.length) return [makeSummaryItem(row, 'ALL', fallbackCount(row), index)];
    return dates.map((statDate, dateIndex) => makeSummaryItem(row, statDate, fallbackCountForDate(row, statDate), `${index}-${dateIndex}`));
  });
  job.logs.push('dry-run 使用 Node 后端模拟分区数据量明细。');
  return true;
}

async function runJob(job, restoreMode, options) {
  const dryRun = isDryRun(restoreMode);
  const configPath = writeTaskConfig(job.rows, restoreMode, {
    targetDatabase: restoreMode === 'cross' ? options.targetDatabase : '',
    preferRowDatabase: restoreMode === 'cross'
  });
  job.configPath = configPath;
  job.logs.push(`任务配置文件：${configPath}`);
  if (restoreMode === 'continuous' || restoreMode === 'single') {
    job.logs.push(`恢复源类型：${options.sourceType === 'unmasked' ? '未脱敏数据' : '脱敏数据'}`);
  }
  job.logs.push(dryRun ? getDryRunReason(restoreMode) : '已开启真实脚本执行。');
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
      await executeRestoreScript(job, restoreMode, configPath, options);
    }
    for (const row of job.rows) {
      if (row.status !== 'failed') {
      row.progress = 100;
      row.status = 'completed';
      row.statusText = statusText.completed;
      }
    }
    const countSucceeded = await queryCounts(job);
    job.logs.push(countSucceeded ? '恢复脚本执行完成，数据量已回查。' : '恢复脚本执行完成，数据量回查失败，请查看日志。');
  } catch (error) {
    job.status = 'failed';
    job.logs.push(`恢复脚本执行失败：${error.message}`);
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
    const { rows, configPath, viewInputPath } = buildRows(fields, files.file);
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
            : '已生成恢复配置。'
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
