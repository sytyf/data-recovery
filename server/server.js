import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

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
    sourceRoot: process.env.RECOVERY_SOURCE_ROOT || localConfig.sourceRoot || '',
    stageRoot: process.env.RECOVERY_STAGE_ROOT || localConfig.stageRoot || ''
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
    id: `source-${index + 1}`,
    databaseName: item.databaseName,
    tableName: item.tableName,
    startDate: normalizeDate(item.startDate, start),
    endDate: normalizeDate(item.endDate, end)
  })).filter((row) => row.databaseName && row.tableName);
  return { rows, configPath: writeTaskConfig(rows, 'source') };
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
  const databaseName = options.targetDatabase || row.databaseName;
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
  if (restoreMode === 'continuous') {
    if (!options.sourceRoot) throw new Error('连续时间段恢复缺少本地源目录配置，请设置 .env 中的 RECOVERY_SOURCE_ROOT 或 config/recovery.local.json 的 sourceRoot');
    if (!options.stageRoot) throw new Error('连续时间段恢复缺少中转目录配置，请设置 .env 中的 RECOVERY_STAGE_ROOT 或 config/recovery.local.json 的 stageRoot');
    return [scriptPath, options.sourceRoot, options.stageRoot, configPath];
  }
  if (restoreMode === 'single') {
    if (!options.sourceRoot) throw new Error('单日期恢复缺少本地源目录配置，请设置 .env 中的 RECOVERY_SOURCE_ROOT 或 config/recovery.local.json 的 sourceRoot');
    return [scriptPath, options.sourceRoot, configPath];
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

function parseCountOutput(outputPath, rows) {
  const byKey = new Map(rows.map((row) => [`${row.viewName || ''}|${row.tableName}`, { ...row, count: 0, dates: [] }]));
  const lines = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').split(/\r?\n/) : [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    const hasView = parts.length === 4;
    const viewName = hasView ? parts[0] : '';
    const tableName = hasView ? parts[1] : parts[0];
    const statDate = hasView ? parts[2] : parts[1];
    const count = Number(hasView ? parts[3] : parts[2]);
    const key = `${viewName}|${tableName}`;
    const item = byKey.get(key) || { id: key, viewName, databaseName: '', tableName, count: 0, dates: [] };
    item.count += Number.isFinite(count) ? count : 0;
    item.dates.push(statDate);
    byKey.set(key, item);
  }
  return [...byKey.values()];
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

function parseDirectCountOutput(output, rows) {
  const byIndex = new Map(rows.map((row, index) => [String(index + 1), { ...row, count: 0, dates: [] }]));
  for (const rawLine of output.split(/\r?\n/)) {
    const line = cleanBeelineLine(rawLine);
    if (!line.startsWith('__COUNT__|')) continue;
    const [, rowIndex, statDate, countText] = line.split('|');
    const item = byIndex.get(rowIndex);
    if (!item) continue;
    const count = Number(countText);
    item.count += Number.isFinite(count) ? count : 0;
    item.dates.push(statDate);
  }
  return [...byIndex.values()];
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
    summary: parseDirectCountOutput(output, rows)
  };
}

async function queryCounts(job, configPath) {
  if (isExecutionEnabled()) {
    try {
      const result = queryCountsDirect(job.rows);
      job.summary = result.summary;
      job.logs.push(`数据量批量回查完成：${result.sqlPath}`);
      return;
    } catch (error) {
      job.logs.push(`批量直连回查失败，回退到 count_table_rows.sh：${error.message}`);
    }
  }

  if (isExecutionEnabled() && fs.existsSync(path.join(scriptDir, 'count_table_rows.sh'))) {
    const outputPath = path.join(generatedDir, `count-result-${job.id}.txt`);
    try {
      runScriptSync('count_table_rows.sh', [configPath, outputPath]);
      job.summary = parseCountOutput(outputPath, job.rows);
      job.logs.push(`数据量回查完成：${outputPath}`);
      return;
    } catch (error) {
      job.logs.push(`数据量回查脚本失败，使用前端占位统计：${error.message}`);
    }
  }
  job.summary = job.rows.map((row) => ({ ...row, count: fallbackCount(row) }));
}

async function runJob(job, restoreMode, options) {
  const dryRun = isDryRun(restoreMode);
  const configPath = writeTaskConfig(job.rows, restoreMode, {
    targetDatabase: restoreMode === 'cross' ? options.targetDatabase : ''
  });
  job.configPath = configPath;
  job.logs.push(`任务配置文件：${configPath}`);
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
    await queryCounts(job, configPath);
    job.logs.push('恢复脚本执行完成，数据量已回查。');
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
        `已读取 ${rows.length} 个恢复对象。`,
        fields.mode === 'view' ? '已根据视图名解析源表并生成恢复配置。' : '已生成恢复配置。'
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
    if (payload.restoreMode === 'cross' && !payload.targetDatabase) {
      throw new Error('跨库数据恢复需要填写目标库');
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
    const localPathConfig = getLocalPathConfig();
    runJob(job, payload.restoreMode, {
      targetDatabase: payload.targetDatabase,
      sourceRoot: localPathConfig.sourceRoot,
      stageRoot: localPathConfig.stageRoot
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
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
  if (req.method === 'POST' && url.pathname === '/api/parse') return handleParse(req, res);
  if (req.method === 'POST' && url.pathname === '/api/restore') return handleRestore(req, res);
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
