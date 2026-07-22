<script setup>
import { computed, ref } from 'vue';
import { aggregateViewSourceRows } from './view-source-rows.js';

const modes = [
  {
    key: 'view',
    index: '1',
    title: '视图恢复',
    detail: '上传 Excel，读取视图名和恢复日期，并解析源表'
  },
  {
    key: 'source',
    index: '2',
    title: '源表恢复',
    detail: '上传 Excel，读取库名、源表名和恢复日期'
  },
  {
    key: 'full',
    index: '3',
    title: '本地全库恢复',
    detail: '输入库名和日期，读取库下全部表名'
  },
  {
    key: 'view-source',
    index: '4',
    title: '视图源表查询',
    detail: '上传 Excel，读取视图源表映射并导出结果'
  },
  {
    key: 'count',
    index: '5',
    title: '数据量查询',
    detail: '上传 Excel，读取库名、表名和日期范围，生成数据量统计 Excel'
  },
  {
    key: 'package',
    index: '6',
    title: '数据文件打包',
    detail: '上传清单，读取库名、表名和日期范围并执行 HDFS get'
  }
];

const restoreModes = [
  {
    key: 'continuous',
    title: '连续时间段恢复',
    hint: '适合整月或全表数据恢复',
    icon: 'M4 6h16M4 12h16M4 18h16'
  },
  {
    key: 'single',
    title: '单日期恢复',
    hint: '适合单个日期或较短连续日期',
    icon: 'M7 3v4M17 3v4M4 9h16M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z'
  },
  {
    key: 'cross',
    title: '跨库数据恢复',
    hint: '从 prodb_dm 拷贝到目标库同名表',
    icon: 'M8 7h8l-3-3M16 7l-3 3M16 17H8l3-3M8 17l3 3'
  }
];

const packageModes = [
  {
    key: 'package',
    title: '开始数据文件打包',
    hint: '从 HDFS 拷贝数据文件到配置的本地打包目录',
    icon: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'
  }
];

const viewSourceModes = [
  {
    key: 'view-source-query',
    title: '查询视图源表',
    hint: '解析视图定义并导出视图与源表映射 Excel',
    icon: 'M4 5h16M4 12h16M4 19h16M8 5v14M16 5v14'
  }
];

const countModes = [
  {
    key: 'view-count',
    title: '视图数据量查询',
    hint: '先解析视图源表，再查询日期分区数据量',
    icon: 'M4 5h16M4 12h16M4 19h16M8 5v14M16 5v14'
  },
  {
    key: 'source-count',
    title: '贴源表数据量查询',
    hint: '按清单中的库名和表名直接查询数据量',
    icon: 'M4 7h16M4 12h16M4 17h16M7 4v16M17 4v16'
  }
];

const sourceOptions = [
  { key: 'masked', title: '脱敏数据恢复', hint: '使用脱敏数据恢复源路径' },
  { key: 'unmasked', title: '未脱敏数据恢复', hint: '使用未脱敏数据恢复源路径' }
];

const fieldTips = {
  startDate: '清单每行有开始日期时优先使用清单值；清单缺失时使用这里作为默认恢复开始日期。',
  endDate: '清单每行有结束日期时优先使用清单值；清单缺失时使用这里作为默认恢复结束日期。',
  targetDatabase: '仅跨库数据恢复使用。优先使用清单每行的库名作为目标库；清单库名为空时，使用这里填写的统一目标库。',
  sourceDatabase: '仅跨库数据恢复使用。作为数据源库；未填写时优先使用 SOURCE_DATABASE 配置，没有配置时默认为 prodb_dm。'
};

const activeMode = ref('view');
const selectedFile = ref(null);
const database = ref('');
const targetDatabase = ref('');
const sourceDatabase = ref('');
const startDate = ref('');
const endDate = ref('');
const sourceType = ref('');
const rows = ref([]);
const logs = ref(['等待上传或读取清单...']);
const summary = ref([]);
const summaryFile = ref(null);
const summaryTotal = ref(0);
const summaryZeroTotal = ref(0);
const countStatus = ref('idle');
const countProgress = ref(0);
const countText = ref('');
const parsing = ref(false);
const running = ref(false);
const paused = ref(false);
const controlling = ref(false);
const currentJobId = ref('');
const parseMeta = ref(null);
const notice = ref('');
const confirmTerminate = ref(false);
let eventSource = null;

const activeModeInfo = computed(() => modes.find((mode) => mode.key === activeMode.value));
const availableActions = computed(() => {
  if (activeMode.value === 'view-source') return viewSourceModes;
  if (activeMode.value === 'package') return packageModes;
  if (activeMode.value === 'count') return countModes;
  return restoreModes;
});
const actionNoun = computed(() => (
  activeMode.value === 'package'
    ? '打包'
    : activeMode.value === 'count' || activeMode.value === 'view-source' ? '查询' : '恢复'
));
const displayRows = computed(() => {
  if (activeMode.value !== 'view-source') return rows.value;
  return aggregateViewSourceRows(rows.value);
});
const completedCount = computed(() => displayRows.value.filter((row) => row.status === 'completed').length);
const failedCount = computed(() => displayRows.value.filter((row) => row.status === 'failed').length);
const runningCount = computed(() => displayRows.value.filter((row) => row.status === 'running').length);
const pendingCount = computed(() => displayRows.value.filter((row) => row.status === 'pending').length);
const shellState = computed(() => {
  if (running.value && paused.value) return { label: `${actionNoun.value}已暂停`, state: 'paused' };
  if (running.value) return { label: `${actionNoun.value}执行中`, state: 'running' };
  if (failedCount.value) return { label: '存在失败行', state: 'failed' };
  if (displayRows.value.length && completedCount.value === displayRows.value.length) return { label: `${actionNoun.value}完成`, state: 'completed' };
  return { label: '待执行', state: 'idle' };
});
const totalProgress = computed(() => {
  if (!displayRows.value.length) return 0;
  return Math.round(displayRows.value.reduce((sum, row) => sum + Number(row.progress || 0), 0) / displayRows.value.length);
});
const visibleTotalProgress = computed(() => (activeMode.value === 'count' ? countProgress.value : totalProgress.value));
const taskStats = computed(() => [
  { label: '总任务数', value: displayRows.value.length, tone: 'neutral' },
  { label: '已完成', value: completedCount.value, tone: 'success' },
  { label: '失败任务', value: failedCount.value, tone: 'danger' },
  { label: '执行中', value: runningCount.value, tone: 'info' },
  { label: '待执行', value: pendingCount.value, tone: 'muted' },
  { label: '完成率', value: `${visibleTotalProgress.value}%`, tone: 'success' }
]);

/**
 * 方法说明：执行 selectMode 方法，完成对应业务处理。
 * @param {*} mode - 当前功能模式。
 * @returns {*} - 方法执行结果。
 */
function selectMode(mode) {
  if (running.value) {
    showNotice(`当前${actionNoun.value}任务正在执行，请先暂停或终止后再切换流程。`);
    return;
  }
  activeMode.value = mode;
  rows.value = [];
  summary.value = [];
  summaryFile.value = null;
  summaryTotal.value = 0;
  summaryZeroTotal.value = 0;
  resetSummaryState();
  parseMeta.value = null;
  logs.value = ['已切换清单类型，等待新的输入。'];
}

/**
 * 方法说明：执行 resetSummaryState 方法，完成对应业务处理。
 * @returns {*} - 方法执行结果。
 */
function resetSummaryState() {
  summary.value = [];
  summaryFile.value = null;
  summaryTotal.value = 0;
  summaryZeroTotal.value = 0;
  countStatus.value = 'idle';
  countProgress.value = 0;
  countText.value = '';
}

/**
 * 方法说明：执行 closeJobStream 方法，完成对应业务处理。
 * @returns {*} - 方法执行结果。
 */
function closeJobStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

/**
 * 方法说明：执行 onFileChange 方法，完成对应业务处理。
 * @param {*} event - 参数 event。
 * @returns {*} - 方法执行结果。
 */
function onFileChange(event) {
  selectedFile.value = event.target.files?.[0] || null;
}

/**
 * 方法说明：执行 showNotice 方法，完成对应业务处理。
 * @param {*} message - 参数 message。
 * @returns {*} - 方法执行结果。
 */
function showNotice(message) {
  notice.value = message;
}

/**
 * 方法说明：执行 clearNotice 方法，完成对应业务处理。
 * @returns {*} - 方法执行结果。
 */
function clearNotice() {
  notice.value = '';
}

/**
 * 方法说明：执行 hasMissingDateRows 方法，完成对应业务处理。
 * @param {*} sourceRows - 参数 sourceRows。
 * @returns {*} - 方法执行结果。
 */
function hasMissingDateRows(sourceRows = rows.value) {
  return sourceRows.some((row) => !row.startDate || !row.endDate);
}

/**
 * 方法说明：执行 validateBeforeParse 方法，完成对应业务处理。
 * @returns {*} - 方法执行结果。
 */
function validateBeforeParse() {
  if (activeMode.value !== 'full' && !selectedFile.value) {
    showNotice(`请先上传${activeModeInfo.value.title}清单文件，再点击读取清单。`);
    return false;
  }
  if (activeMode.value === 'full') {
    if (!database.value) {
      showNotice('请先输入库名，再读取本地全库表名。');
      return false;
    }
    if (!startDate.value || !endDate.value) {
      showNotice('本地全库恢复需要先选择恢复开始日期和恢复结束日期。');
      return false;
    }
  }
  return true;
}

/**
 * 方法说明：执行 validateBeforeRestore 方法，完成对应业务处理。
 * @param {*} restoreMode - 恢复方式。
 * @returns {*} - 方法执行结果。
 */
function validateBeforeRestore(restoreMode) {
  if (running.value) return false;
  if (!rows.value.length) {
    showNotice(`请先读取清单，再执行${restoreMode === 'package' ? '数据文件打包' : '数据恢复'}。`);
    return false;
  }
  const validRows = rows.value.filter((row) => row.status !== 'failed');
  if (activeMode.value !== 'view-source' && hasMissingDateRows(validRows)) {
    showNotice('存在未填写恢复开始日期或恢复结束日期的行，请在 Excel 中补充日期，或在页面日期输入框中设置默认时间段后重新读取清单。');
    return false;
  }
  if (activeMode.value === 'view-source') {
    if (validRows.some((row) => !row.viewName)) {
      showNotice('视图源表查询要求每行都包含视图名。');
      return false;
    }
    return true;
  }
  if (restoreMode === 'continuous' || restoreMode === 'single') {
    if (!sourceType.value) {
      showNotice('请先选择恢复源类型：脱敏数据恢复或未脱敏数据恢复。');
      return false;
    }
    if (validRows.some((row) => !row.databaseName)) {
      showNotice('连续时间段恢复和单日期恢复要求每行都包含库名，请补充清单后重新读取。');
      return false;
    }
  }
  if (restoreMode === 'cross') {
    const missingTarget = validRows.some((row) => !row.databaseName);
    if (missingTarget && !targetDatabase.value) {
      showNotice('跨库恢复存在清单库名为空的行，请填写跨库目标库作为统一兜底。');
      return false;
    }
  }
  if (restoreMode === 'package' && validRows.some((row) => !row.databaseName || !row.tableName)) {
    showNotice('数据文件打包要求清单中每行都包含库名和表名，请补充后重新读取。');
    return false;
  }
  if (activeMode.value === 'count') {
    if (validRows.some((row) => !row.tableName)) {
      showNotice('数据量查询要求清单中每行都包含表名。');
      return false;
    }
    if (restoreMode === 'source-count' && validRows.some((row) => !row.databaseName)) {
      showNotice('贴源表数据量查询要求清单中每行都包含库名。');
      return false;
    }
  }
  return true;
}

/**
 * 方法说明：执行 parseList 方法，完成对应业务处理。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function parseList() {
  if (!validateBeforeParse()) return;
  parsing.value = true;
  rows.value = [];
  resetSummaryState();
  logs.value = ['开始读取清单...'];
  parseMeta.value = null;

  const formData = new FormData();
  formData.append('mode', activeMode.value);
  formData.append('database', database.value);
  formData.append('startDate', startDate.value);
  formData.append('endDate', endDate.value);
  if (selectedFile.value) formData.append('file', selectedFile.value);

  try {
    const response = await fetch('/api/parse', {
      method: 'POST',
      body: formData
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '清单读取失败');
    rows.value = payload.rows;
    parseMeta.value = payload.meta;
    logs.value = payload.logs;
    if (activeMode.value === 'count') {
      countText.value = `已读取 ${payload.rows.length} 行查询清单，请选择查询方式。`;
      countProgress.value = 0;
    }
  } catch (error) {
    logs.value = [`读取失败：${error.message}`];
  } finally {
    parsing.value = false;
  }
}

/**
 * 方法说明：执行 startRestore 方法，完成对应业务处理。
 * @param {*} restoreMode - 恢复方式。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function startRestore(restoreMode) {
  if (!validateBeforeRestore(restoreMode)) return;
  running.value = true;
  paused.value = false;
  currentJobId.value = '';
  const actionInfo = availableActions.value.find((mode) => mode.key === restoreMode);
  logs.value = [`启动${actionInfo.title}...`];
  resetSummaryState();
  if (activeMode.value === 'count') {
    countStatus.value = 'running';
    countProgress.value = 1;
    countText.value = `正在启动${actionInfo.title}...`;
  }

  const endpoint = activeMode.value === 'count'
    ? '/api/count-query'
    : activeMode.value === 'view-source'
      ? '/api/view-source-query'
    : restoreMode === 'package'
      ? '/api/package'
      : '/api/restore';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      restoreMode,
      queryMode: activeMode.value === 'count' ? restoreMode : '',
      sourceMode: activeMode.value,
      sourceType: sourceType.value,
      targetDatabase: targetDatabase.value,
      sourceDatabase: sourceDatabase.value,
      rows: rows.value
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    logs.value = [`${actionNoun.value}启动失败：${payload.error || '未知错误'}`];
    showNotice(payload.error || `${actionNoun.value}启动失败`);
    running.value = false;
    return;
  }

  if (eventSource) eventSource.close();
  currentJobId.value = payload.jobId;
  eventSource = new EventSource(`/api/jobs/${payload.jobId}/events`);
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.rows) rows.value = data.rows;
    if (data.logs) logs.value = data.logs;
    if (typeof data.paused === 'boolean') paused.value = data.paused;
    if (data.summary) summary.value = data.summary;
    if (typeof data.summaryTotal === 'number') summaryTotal.value = data.summaryTotal;
    if (typeof data.summaryZeroTotal === 'number') summaryZeroTotal.value = data.summaryZeroTotal;
    if (data.summaryFile !== undefined) summaryFile.value = data.summaryFile;
    if (data.countStatus) countStatus.value = data.countStatus;
    if (typeof data.countProgress === 'number') {
      const terminalCountStatus = ['completed', 'failed', 'canceled'].includes(data.countStatus);
      countProgress.value = terminalCountStatus ? 100 : Math.max(countProgress.value, data.countProgress);
    }
    if (data.countText !== undefined) countText.value = data.countText;
    if (data.status === 'completed' || data.status === 'failed' || data.status === 'canceled') {
      running.value = false;
      paused.value = false;
      currentJobId.value = '';
      eventSource.close();
      eventSource = null;
    }
  };
  eventSource.onerror = () => {
    logs.value = [`${actionNoun.value}事件连接中断，请检查后端服务。`];
    running.value = false;
    paused.value = false;
    currentJobId.value = '';
    eventSource.close();
    eventSource = null;
  };
}

/**
 * 方法说明：执行 controlCurrentJob 方法，完成对应业务处理。
 * @param {*} action - 任务控制动作。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function controlCurrentJob(action) {
  if (!currentJobId.value) {
    showNotice('当前没有正在执行的任务。');
    return null;
  }
  controlling.value = true;
  try {
    const response = await fetch(`/api/jobs/${currentJobId.value}/${action}`, { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '任务控制失败');
    return payload;
  } catch (error) {
    showNotice(error.message);
    return null;
  } finally {
    controlling.value = false;
  }
}

/**
 * 方法说明：执行 togglePause 方法，完成对应业务处理。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function togglePause() {
  const payload = await controlCurrentJob(paused.value ? 'resume' : 'pause');
  if (!payload) return;
  paused.value = Boolean(payload.paused);
}

/**
 * 方法说明：执行 requestTerminate 方法，完成对应业务处理。
 * @returns {*} - 方法执行结果。
 */
function requestTerminate() {
  if (!running.value || !currentJobId.value) {
    showNotice('当前没有正在执行的任务。');
    return;
  }
  confirmTerminate.value = true;
}

/**
 * 方法说明：执行 terminateCurrentJob 方法，完成对应业务处理。
 * @returns {Promise<*>} - 方法执行结果。
 */
async function terminateCurrentJob() {
  const payload = await controlCurrentJob('cancel');
  if (!payload) return;
  confirmTerminate.value = false;
  closeJobStream();
  running.value = false;
  paused.value = false;
  currentJobId.value = '';
  rows.value = [];
  resetSummaryState();
  logs.value = [`当前${actionNoun.value}任务已终止，恢复对象列表已清空。`];
}
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <h1>数据恢复控制台</h1>
        <p>Hive / HDFS 数据恢复平台 · 读取清单、解析源表、执行恢复、数据打包并回查数据量。</p>
      </div>
      <div class="topbar-actions">
        <a class="template-download" href="/api/templates/recovery.xlsx" download>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
          </svg>
          恢复模版下载
        </a>
        <div class="system-state">
          <span :class="['state-dot', shellState.state, running && !paused ? 'pulse' : '']"></span>
          {{ shellState.label }}
        </div>
      </div>
    </header>

    <section class="workspace">
      <aside class="mode-rail">
        <h2>恢复流程</h2>
        <button
          v-for="mode in modes"
          :key="mode.key"
          :class="['mode-button', { active: activeMode === mode.key }]"
          @click="selectMode(mode.key)"
        >
          <span>{{ mode.index }}</span>
          <strong>{{ mode.title }}</strong>
          <small>{{ mode.detail }}</small>
        </button>
      </aside>

      <section class="main-panel">
        <div class="input-panel">
          <div class="panel-title">
            <h2>{{ activeModeInfo.title }}</h2>
            <p>{{ activeModeInfo.detail }}</p>
          </div>

          <label v-if="activeMode !== 'full'" class="upload-box">
            <input type="file" accept=".xlsx,.xls,.csv" @change="onFileChange" />
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 16V4m0 0 4 4m-4-4-4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            <span>{{ selectedFile ? selectedFile.name : '选择 Excel/CSV 清单文件' }}</span>
          </label>

          <div class="form-grid" :class="{ full: activeMode === 'full' }">
            <label v-if="activeMode === 'full'">
              <span>库名</span>
              <input v-model.trim="database" placeholder="例如 prodb_dm" />
            </label>
            <label>
              <span class="field-label" :title="fieldTips.startDate">{{ activeMode === 'view-source' ? '开始日期（可选）' : '恢复开始日期' }}</span>
              <input v-model="startDate" type="date" />
            </label>
            <label>
              <span class="field-label" :title="fieldTips.endDate">{{ activeMode === 'view-source' ? '结束日期（可选）' : '恢复结束日期' }}</span>
              <input v-model="endDate" type="date" />
            </label>
            <label v-if="activeMode === 'view' || activeMode === 'source'">
              <span class="field-label" :title="fieldTips.targetDatabase">跨库目标库</span>
              <input v-model.trim="targetDatabase" placeholder="清单库名为空时使用" />
            </label>
            <label v-if="activeMode === 'view' || activeMode === 'source'">
              <span class="field-label" :title="fieldTips.sourceDatabase">跨库源库</span>
              <input v-model.trim="sourceDatabase" placeholder="未填写时默认 prodb_dm" />
            </label>
          </div>

          <button class="primary-action" :disabled="parsing" @click="parseList">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h14M13 5l7 7-7 7" />
            </svg>
            {{ parsing ? '读取中...' : activeMode === 'full' ? '读取全库表名' : activeMode === 'count' || activeMode === 'view-source' ? '读取查询清单' : '读取清单' }}
          </button>
        </div>

        <div v-if="activeMode !== 'package' && activeMode !== 'count' && activeMode !== 'view-source'" class="source-selector">
          <div>
            <h2>恢复源类型</h2>
            <p>执行恢复前选择源路径类型，路径由后端本地配置控制。</p>
          </div>
          <div class="source-options">
            <button
              v-for="option in sourceOptions"
              :key="option.key"
              :class="{ active: sourceType === option.key }"
              :disabled="running"
              @click="sourceType = option.key"
            >
              <strong>{{ option.title }}</strong>
              <small>{{ option.hint }}</small>
            </button>
          </div>
        </div>

        <div :class="['action-strip', { package: activeMode === 'package', single: activeMode === 'view-source' }]">
          <button
            v-for="mode in availableActions"
            :key="mode.key"
            :disabled="running"
            @click="startRestore(mode.key)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path :d="mode.icon" />
            </svg>
            <span>
              <strong>{{ mode.title }}</strong>
              <small>{{ mode.hint }}</small>
            </span>
          </button>
        </div>

        <div v-if="running && activeMode !== 'package' && activeMode !== 'count'" class="job-controls">
          <button class="pause-control" :disabled="controlling" @click="togglePause">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path v-if="paused" d="M8 5v14l11-7-11-7Z" />
              <path v-else d="M8 5v14M16 5v14" />
            </svg>
            {{ paused ? `继续${actionNoun}` : `暂停${actionNoun}` }}
          </button>
          <button class="terminate-control" :disabled="controlling" @click="requestTerminate">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6h12v12H6z" />
            </svg>
            终止{{ actionNoun }}
          </button>
        </div>

        <div v-if="activeMode === 'count'" class="count-query-panel">
          <div class="count-query-copy">
            <h2>查询进度</h2>
            <p>{{ rows.length ? `已读取 ${rows.length} 行查询清单。` : '读取查询清单后显示总体进度。' }}</p>
          </div>
          <div class="count-query-progress">
            <div class="count-progress-head">
              <span>{{ countText || (rows.length ? '等待选择查询方式。' : '等待读取查询清单。') }}</span>
              <strong>{{ visibleTotalProgress }}%</strong>
            </div>
            <div class="count-progress-track">
              <span :style="{ width: `${visibleTotalProgress}%` }"></span>
            </div>
          </div>
          <a
            v-if="summaryFile?.url"
            class="summary-download"
            :href="summaryFile.url"
            download
          >
            下载数据量统计 Excel
          </a>
        </div>

        <div v-else class="table-panel">
          <div class="table-header">
            <h2>{{ activeMode === 'package' ? '打包对象' : activeMode === 'count' || activeMode === 'view-source' ? '查询对象' : '恢复对象' }}</h2>
            <div class="metrics">
              <span>{{ displayRows.length }} 行</span>
              <span>{{ completedCount }} 完成</span>
              <span>{{ visibleTotalProgress }}%</span>
            </div>
          </div>

          <div class="table-wrap">
            <table :class="{ 'view-source-table': activeMode === 'view-source' }">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>视图名</th>
                  <th v-if="activeMode === 'view-source'">源表</th>
                  <template v-else>
                    <th>库名</th>
                    <th>表名</th>
                  </template>
                  <th>开始日期</th>
                  <th>结束日期</th>
                  <th>状态</th>
                  <th>进度</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, index) in displayRows" :key="row.id">
                  <td>{{ index + 1 }}</td>
                  <td>{{ row.viewName || '-' }}</td>
                  <td v-if="activeMode === 'view-source'" class="source-tables-cell" :title="row.sourceTables">{{ row.sourceTables || '-' }}</td>
                  <template v-else>
                    <td>{{ row.databaseName }}</td>
                    <td>{{ row.tableName }}</td>
                  </template>
                  <td>{{ row.startDate }}</td>
                  <td>{{ row.endDate }}</td>
                  <td>
                    <span :class="['status-pill', row.status]">
                      <svg v-if="row.status === 'completed'" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m5 13 4 4L19 7" />
                      </svg>
                      {{ row.statusText }}
                    </span>
                  </td>
                  <td>
                    <div class="progress-cell">
                      <div class="progress-track">
                        <span :style="{ width: `${row.progress || 0}%` }"></span>
                      </div>
                      <b>{{ row.progress || 0 }}%</b>
                    </div>
                  </td>
                </tr>
                <tr v-if="!displayRows.length">
                  <td :colspan="activeMode === 'view-source' ? 7 : 8" class="empty">上传清单或读取全库后，这里会显示待处理对象。</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <aside class="side-panel">
        <section>
          <h2>执行日志</h2>
          <ol class="log-list">
            <li v-for="(line, index) in logs" :key="`${line}-${index}`">{{ line }}</li>
          </ol>
        </section>

        <section>
          <div class="section-heading">
            <div>
              <h2>{{ activeMode === 'view-source' ? '视图源表查询结果' : activeMode === 'count' ? '数据量查询结果' : '数据量回查' }}</h2>
              <p v-if="summaryTotal">明细 {{ summaryTotal }} 条，0 数据分区 {{ summaryZeroTotal }} 条</p>
              <p v-else>{{ activeMode === 'view-source' ? '查询完成后生成视图与源表映射 Excel 明细' : '回查完成后生成完整 Excel 明细' }}</p>
            </div>
            <a
              v-if="summaryFile?.url"
              class="summary-download"
              :href="summaryFile.url"
              download
            >
              明细下载
            </a>
          </div>
          <div v-if="countStatus !== 'idle'" :class="['count-progress-card', countStatus]">
            <div class="count-progress-head">
              <span>{{ countText || '数据量回查处理中...' }}</span>
              <strong>{{ countProgress }}%</strong>
            </div>
            <div class="count-progress-track">
              <span :style="{ width: `${countProgress}%` }"></span>
            </div>
          </div>
          <div v-if="summary.length" class="summary-table">
            <table>
              <thead>
                <tr>
                  <th>表名</th>
                  <th>0 数据分区</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in summary" :key="item.id">
                  <td :title="`${item.databaseName}.${item.tableName}`">{{ item.tableName }}</td>
                  <td>{{ item.statDate }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else-if="summaryFile" class="summary-empty">
            {{ activeMode === 'view-source' ? '视图源表查询完成，可下载 Excel 查看完整映射。' : activeMode === 'count' ? '查询完成，未发现数据量为 0 的时间分区。可下载 Excel 查看完整明细。' : '回查完成，未发现数据量为 0 的时间分区。可下载 Excel 查看完整明细。' }}
          </p>
          <p v-else class="summary-empty">
            {{ activeMode === 'view-source' ? '查询完成后可下载视图与源表映射 Excel。' : activeMode === 'count' ? '查询完成后可下载完整 Excel 明细，页面仅展示数据量为 0 的时间分区。' : '恢复完成后仅展示数据量为 0 的时间分区，完整明细可下载 Excel。' }}
          </p>
        </section>

        <section>
          <h2>{{ activeMode === 'count' ? '查询任务统计' : '恢复任务统计' }}</h2>
          <div class="task-stats">
            <article v-for="item in taskStats" :key="item.label" :class="item.tone">
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
            </article>
          </div>
        </section>

        <section v-if="parseMeta" class="meta-box">
          <h2>配置文件</h2>
          <p>{{ parseMeta.configPath }}</p>
          <small v-if="parseMeta.dryRun">
            当前为 dry-run，未执行真实恢复。请确认 .env 中 RECOVERY_EXECUTE=1，并重启后端服务。
          </small>
          <small v-else>已接入真实后端执行，shell 脚本仅作为失败备用方案。</small>
        </section>
      </aside>
    </section>

    <div v-if="notice" class="notice-backdrop" role="alertdialog" aria-modal="true">
      <div class="notice-dialog">
        <h2>操作提示</h2>
        <p>{{ notice }}</p>
        <button type="button" @click="clearNotice">知道了</button>
      </div>
    </div>

    <div v-if="confirmTerminate" class="notice-backdrop" role="alertdialog" aria-modal="true">
      <div class="notice-dialog confirm-dialog">
        <h2>确认终止恢复</h2>
        <p>确认后当前任务会停止执行，恢复对象列表会被清空。已完成的数据不会自动回滚。</p>
        <div class="dialog-actions">
          <button type="button" class="secondary" :disabled="controlling" @click="confirmTerminate = false">取消</button>
          <button type="button" class="danger" :disabled="controlling" @click="terminateCurrentJob">
            {{ controlling ? '终止中...' : '确认终止' }}
          </button>
        </div>
      </div>
    </div>
  </main>
</template>
