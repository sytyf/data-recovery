export function aggregateViewSourceRows(rows) {
  const groups = new Map();
  rows.forEach((row, index) => {
    const key = `${row.viewName || ''}|${row.startDate || ''}|${row.endDate || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        baseRow: row,
        id: `view-source-display-${index}`,
        rows: [],
        sourceTableList: [],
        sourceTableSet: new Set()
      });
    }
    const group = groups.get(key);
    group.rows.push(row);
    if (row.databaseName && row.tableName && row.tableName !== '-') {
      const sourceTable = `${row.databaseName}.${row.tableName}`;
      if (!group.sourceTableSet.has(sourceTable)) {
        group.sourceTableSet.add(sourceTable);
        group.sourceTableList.push(sourceTable);
      }
    }
  });

  return [...groups.values()].map((group) => {
    const failedRow = group.rows.find((row) => row.status === 'failed');
    const runningRow = group.rows.find((row) => row.status === 'running');
    const pendingRow = group.rows.find((row) => row.status === 'pending');
    const statusRow = failedRow || runningRow || pendingRow || group.rows[0];
    return {
      ...group.baseRow,
      id: group.id,
      sourceTables: group.sourceTableList.join(','),
      status: statusRow.status,
      statusText: failedRow?.statusText || statusRow.statusText,
      progress: Math.min(...group.rows.map((row) => Number(row.progress || 0)))
    };
  });
}
