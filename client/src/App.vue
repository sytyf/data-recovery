<script setup>
import { computed, ref } from 'vue';

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
    key: 'package',
    index: '4',
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

const sourceOptions = [
  { key: 'masked', title: '脱敏数据恢复', hint: '使用脱敏数据恢复源路径' },
  { key: 'unmasked', title: '未脱敏数据恢复', hint: '使用未脱敏数据恢复源路径' }
];

const fieldTips = {
  startDate: '清单每行有开始日期时优先使用清单值；清单缺失时使用这里作为默认恢复开始日期。',
  endDate: '清单每行有结束日期时优先使用清单值；清单缺失时使用这里作为默认恢复结束日期。',
  targetDatabase: '仅跨库数据恢复使用。优先使用清单每行的库名作为目标库；清单库名为空时，使用这里填写的统一目标库。源库默认 prodb_dm，可通过 SOURCE_DATABASE 配置修改。'
};

const activeMode = ref('view');
const selectedFile = ref(null);
const database = ref('');
const targetDatabase = ref('');
const startDate = ref('');
const endDate = ref('');
const sourceType = ref('');
const rows = ref([]);
const logs = ref(['等待上传或读取清单...']);
const summary = ref([]);
const parsing = ref(false);
const running = ref(false);
const parseMeta = ref(null);
const notice = ref('');
let eventSource = null;

const activeModeInfo = computed(() => modes.find((mode) => mode.key === activeMode.value));
const availableActions = computed(() => (activeMode.value === 'package' ? packageModes : restoreModes));
const actionNoun = computed(() => (activeMode.value === 'package' ? '打包' : '恢复'));
const completedCount = computed(() => rows.value.filter((row) => row.status === 'completed').length);
const failedCount = computed(() => rows.value.filter((row) => row.status === 'failed').length);
const runningCount = computed(() => rows.value.filter((row) => row.status === 'running').length);
const pendingCount = computed(() => rows.value.filter((row) => row.status === 'pending').length);
const shellState = computed(() => {
  if (running.value) return { label: `${actionNoun.value}执行中`, state: 'running' };
  if (failedCount.value) return { label: '存在失败行', state: 'failed' };
  if (rows.value.length && completedCount.value === rows.value.length) return { label: `${actionNoun.value}完成`, state: 'completed' };
  return { label: '待执行', state: 'idle' };
});
const totalProgress = computed(() => {
  if (!rows.value.length) return 0;
  return Math.round(rows.value.reduce((sum, row) => sum + Number(row.progress || 0), 0) / rows.value.length);
});
const taskStats = computed(() => [
  { label: '总任务数', value: rows.value.length, tone: 'neutral' },
  { label: '已完成', value: completedCount.value, tone: 'success' },
  { label: '失败任务', value: failedCount.value, tone: 'danger' },
  { label: '执行中', value: runningCount.value, tone: 'info' },
  { label: '待执行', value: pendingCount.value, tone: 'muted' },
  { label: '完成率', value: `${totalProgress.value}%`, tone: 'success' }
]);

function selectMode(mode) {
  activeMode.value = mode;
  rows.value = [];
  summary.value = [];
  parseMeta.value = null;
  logs.value = ['已切换清单类型，等待新的输入。'];
}

function onFileChange(event) {
  selectedFile.value = event.target.files?.[0] || null;
}

function showNotice(message) {
  notice.value = message;
}

function clearNotice() {
  notice.value = '';
}

function hasMissingDateRows() {
  return rows.value.some((row) => !row.startDate || !row.endDate);
}

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

function validateBeforeRestore(restoreMode) {
  if (running.value) return false;
  if (!rows.value.length) {
    showNotice(`请先读取清单，再执行${restoreMode === 'package' ? '数据文件打包' : '数据恢复'}。`);
    return false;
  }
  if (hasMissingDateRows()) {
    showNotice('存在未填写恢复开始日期或恢复结束日期的行，请在 Excel 中补充日期，或在页面日期输入框中设置默认时间段后重新读取清单。');
    return false;
  }
  if (restoreMode === 'continuous' || restoreMode === 'single') {
    if (!sourceType.value) {
      showNotice('请先选择恢复源类型：脱敏数据恢复或未脱敏数据恢复。');
      return false;
    }
    if (rows.value.some((row) => !row.databaseName)) {
      showNotice('连续时间段恢复和单日期恢复要求每行都包含库名，请补充清单后重新读取。');
      return false;
    }
  }
  if (restoreMode === 'cross') {
    const missingTarget = rows.value.some((row) => !row.databaseName);
    if (missingTarget && !targetDatabase.value) {
      showNotice('跨库恢复存在清单库名为空的行，请填写跨库目标库作为统一兜底。');
      return false;
    }
  }
  if (restoreMode === 'package' && rows.value.some((row) => !row.databaseName || !row.tableName)) {
    showNotice('数据文件打包要求清单中每行都包含库名和表名，请补充后重新读取。');
    return false;
  }
  return true;
}

async function parseList() {
  if (!validateBeforeParse()) return;
  parsing.value = true;
  rows.value = [];
  summary.value = [];
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
  } catch (error) {
    logs.value = [`读取失败：${error.message}`];
  } finally {
    parsing.value = false;
  }
}

async function startRestore(restoreMode) {
  if (!validateBeforeRestore(restoreMode)) return;
  running.value = true;
  const actionInfo = availableActions.value.find((mode) => mode.key === restoreMode);
  logs.value = [`启动${actionInfo.title}...`];
  summary.value = [];

  const response = await fetch(restoreMode === 'package' ? '/api/package' : '/api/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      restoreMode,
      sourceMode: activeMode.value,
      sourceType: sourceType.value,
      targetDatabase: targetDatabase.value,
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
  eventSource = new EventSource(`/api/jobs/${payload.jobId}/events`);
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.rows) rows.value = data.rows;
    if (data.logs) logs.value = data.logs;
    if (data.summary) summary.value = data.summary;
    if (data.status === 'completed' || data.status === 'failed') {
      running.value = false;
      eventSource.close();
    }
  };
  eventSource.onerror = () => {
    logs.value = [`${actionNoun.value}事件连接中断，请检查后端服务。`];
    running.value = false;
    eventSource.close();
  };
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
          <span :class="['state-dot', shellState.state, running ? 'pulse' : '']"></span>
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
              <span class="field-label" :title="fieldTips.startDate">恢复开始日期</span>
              <input v-model="startDate" type="date" />
            </label>
            <label>
              <span class="field-label" :title="fieldTips.endDate">恢复结束日期</span>
              <input v-model="endDate" type="date" />
            </label>
            <label>
              <span class="field-label" :title="fieldTips.targetDatabase">跨库目标库</span>
              <input v-model.trim="targetDatabase" placeholder="清单库名为空时使用" />
            </label>
          </div>

          <button class="primary-action" :disabled="parsing" @click="parseList">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h14M13 5l7 7-7 7" />
            </svg>
            {{ parsing ? '读取中...' : activeMode === 'full' ? '读取全库表名' : '读取清单' }}
          </button>
        </div>

        <div v-if="activeMode !== 'package'" class="source-selector">
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

        <div :class="['action-strip', { package: activeMode === 'package' }]">
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

        <div class="table-panel">
          <div class="table-header">
            <h2>{{ activeMode === 'package' ? '打包对象' : '恢复对象' }}</h2>
            <div class="metrics">
              <span>{{ rows.length }} 行</span>
              <span>{{ completedCount }} 完成</span>
              <span>{{ totalProgress }}%</span>
            </div>
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>视图名</th>
                  <th>库名</th>
                  <th>表名</th>
                  <th>开始日期</th>
                  <th>结束日期</th>
                  <th>状态</th>
                  <th>进度</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in rows" :key="row.id">
                  <td>{{ row.viewName || '-' }}</td>
                  <td>{{ row.databaseName }}</td>
                  <td>{{ row.tableName }}</td>
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
                <tr v-if="!rows.length">
                  <td colspan="7" class="empty">上传清单或读取全库后，这里会显示待处理对象。</td>
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
          <h2>数据量回查</h2>
          <div v-if="summary.length" class="summary-table">
            <table>
              <thead>
                <tr>
                  <th>表名</th>
                  <th>日期</th>
                  <th>数据量</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in summary" :key="item.id">
                  <td :title="`${item.databaseName}.${item.tableName}`">{{ item.tableName }}</td>
                  <td>{{ item.statDate }}</td>
                  <td>{{ item.count.toLocaleString() }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="summary-empty">恢复完成后展示表、单个日期分区和数据量。</p>
        </section>

        <section>
          <h2>恢复任务统计</h2>
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
            当前为 dry-run，未调用真实恢复脚本。请确认 .env 中 RECOVERY_EXECUTE=1，并重启后端服务。
          </small>
          <small v-else>已接入真实脚本执行。</small>
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
  </main>
</template>
