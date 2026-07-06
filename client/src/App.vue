<script setup>
import { computed, ref } from 'vue';

const modes = [
  {
    key: 'view',
    index: '1',
    title: '视图恢复清单',
    detail: '上传 Excel，读取视图名和恢复日期，并解析源表'
  },
  {
    key: 'source',
    index: '2',
    title: '源表恢复清单',
    detail: '上传 Excel，读取库名、源表名和恢复日期'
  },
  {
    key: 'full',
    index: '3',
    title: '本地全库恢复',
    detail: '输入库名和日期，读取库下全部表名'
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

const activeMode = ref('view');
const selectedFile = ref(null);
const database = ref('');
const targetDatabase = ref('');
const startDate = ref('');
const endDate = ref('');
const rows = ref([]);
const logs = ref(['等待上传或读取清单...']);
const summary = ref([]);
const parsing = ref(false);
const running = ref(false);
const parseMeta = ref(null);
let eventSource = null;

const activeModeInfo = computed(() => modes.find((mode) => mode.key === activeMode.value));
const completedCount = computed(() => rows.value.filter((row) => row.status === 'completed').length);
const failedCount = computed(() => rows.value.filter((row) => row.status === 'failed').length);
const runningCount = computed(() => rows.value.filter((row) => row.status === 'running').length);
const pendingCount = computed(() => rows.value.filter((row) => row.status === 'pending').length);
const shellState = computed(() => {
  if (running.value) return { label: '恢复执行中', state: 'running' };
  if (failedCount.value) return { label: '存在失败行', state: 'failed' };
  if (rows.value.length && completedCount.value === rows.value.length) return { label: '恢复完成', state: 'completed' };
  return { label: '待执行', state: 'idle' };
});
const totalProgress = computed(() => {
  if (!rows.value.length) return 0;
  return Math.round(rows.value.reduce((sum, row) => sum + Number(row.progress || 0), 0) / rows.value.length);
});
const taskStats = computed(() => [
  { label: '总任务数', value: rows.value.length, tone: 'neutral' },
  { label: '已恢复', value: completedCount.value, tone: 'success' },
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

async function parseList() {
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
  if (!rows.value.length || running.value) return;
  running.value = true;
  logs.value = [`启动${restoreModes.find((mode) => mode.key === restoreMode).title}...`];
  summary.value = [];

  const response = await fetch('/api/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      restoreMode,
      sourceMode: activeMode.value,
      targetDatabase: targetDatabase.value,
      rows: rows.value
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    logs.value = [`恢复启动失败：${payload.error || '未知错误'}`];
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
    logs.value = ['恢复事件连接中断，请检查后端服务。'];
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
        <p>Hive / HDFS 数据恢复平台 · 读取清单、解析源表、执行恢复并回查数据量。</p>
      </div>
      <div class="system-state">
        <span :class="['state-dot', shellState.state, running ? 'pulse' : '']"></span>
        {{ shellState.label }}
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
              <span>恢复开始日期</span>
              <input v-model="startDate" type="date" />
            </label>
            <label>
              <span>恢复结束日期</span>
              <input v-model="endDate" type="date" />
            </label>
            <label>
              <span>跨库目标库</span>
              <input v-model.trim="targetDatabase" placeholder="仅跨库恢复需要" />
            </label>
          </div>

          <button class="primary-action" :disabled="parsing" @click="parseList">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h14M13 5l7 7-7 7" />
            </svg>
            {{ parsing ? '读取中...' : activeMode === 'full' ? '读取全库表名' : '读取清单' }}
          </button>
        </div>

        <div class="action-strip">
          <button
            v-for="mode in restoreModes"
            :key="mode.key"
            :disabled="!rows.length || running"
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
            <h2>恢复对象</h2>
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
                  <td colspan="7" class="empty">上传清单或读取全库后，这里会显示待恢复对象。</td>
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
          <div v-if="summary.length" class="summary-list">
            <article v-for="item in summary" :key="item.id">
              <span>{{ item.databaseName }}.{{ item.tableName }}</span>
              <strong>{{ item.count.toLocaleString() }}</strong>
            </article>
          </div>
          <p v-else class="summary-empty">恢复完成后展示表和时间段的数据量。</p>
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
  </main>
</template>
