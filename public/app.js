// --- State ---
let filtersData = null;
let retentionChart = null;
let breakdownChart = null;
let lastAvgA = null;
let lastAvgB = null;

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  // Attach all event listeners first, before any async work
  document.getElementById('applyBtn').addEventListener('click', fetchAndRender);
  document.getElementById('compareMode').addEventListener('change', onCompareModeToggle);

  // Toggle is/is-not buttons
  document.querySelectorAll('.is-not-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode === 'is' ? 'not' : 'is';
      btn.dataset.mode = mode;
      btn.textContent = mode === 'is' ? 'is' : 'is not';
    });
  });

  // Breakdown controls
  document.getElementById('breakdownBy').addEventListener('change', onBreakdownChange);
  document.getElementById('breakdownSearch').addEventListener('input', onBreakdownSearch);
  document.getElementById('breakdownBtn').addEventListener('click', fetchAndRenderBreakdown);

  // Load filter options only (no data fetch until user clicks Apply)
  await loadFilters();
});

// --- Load filter options ---
async function loadFilters() {
  try {
    const res = await fetch('/api/filters');
    filtersData = await res.json();

    populateSelect('coachId', filtersData.coaches.map(c => ({ value: c.id, label: c.name })));
    populateSelect('referralType', filtersData.referralTypes.map(v => ({ value: v, label: v })));
    populateSelect('referralCategory', filtersData.referralCategories.map(v => ({ value: v, label: v })));
    populateSelect('referringOrg', filtersData.referringOrgs.map(o => ({ value: o.id, label: o.name })));

    // Also populate comparison dropdowns
    populateSelect('coachId_b', filtersData.coaches.map(c => ({ value: c.id, label: c.name })));
    populateSelect('referralType_b', filtersData.referralTypes.map(v => ({ value: v, label: v })));
    populateSelect('referralCategory_b', filtersData.referralCategories.map(v => ({ value: v, label: v })));
    populateSelect('referringOrg_b', filtersData.referringOrgs.map(o => ({ value: o.id, label: o.name })));

    // Set defaults
    if (filtersData.earliestMonth) {
      document.getElementById('startDate').value = filtersData.earliestMonth;
    }
    const now = new Date();
    document.getElementById('endDate').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    document.getElementById('minMeetings').value = '1';
    document.getElementById('minMeetings_b').value = '1';
  } catch (err) {
    console.error('Failed to load filters:', err);
  }
}

function populateSelect(id, options) {
  const sel = document.getElementById(id);
  // Keep the first "All" option
  while (sel.options.length > 1) sel.remove(1);
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    sel.appendChild(el);
  }
}

// --- Fetch cohort data ---
function buildQueryParams(suffix = '') {
  const params = new URLSearchParams();
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  const referralType = document.getElementById('referralType' + suffix).value;
  const referralCategory = document.getElementById('referralCategory' + suffix).value;
  const referringOrg = document.getElementById('referringOrg' + suffix).value;
  const hasReferringFriend = document.getElementById('hasReferringFriend' + suffix).checked;
  const coachId = document.getElementById('coachId' + suffix).value;
  const minMeetings = document.getElementById('minMeetings' + suffix).value;
  const graduatedMode = document.getElementById('graduatedMode' + suffix).value;

  if (startDate) params.set('startDate', startDate + '-01');
  if (endDate) {
    // End of the selected month
    const [y, m] = endDate.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    params.set('endDate', `${endDate}-${lastDay}`);
  }
  if (referralType) {
    params.set('referralType', referralType);
    params.set('referralTypeMode', document.getElementById('referralTypeMode' + suffix).dataset.mode);
  }
  if (referralCategory) {
    params.set('referralCategory', referralCategory);
    params.set('referralCategoryMode', document.getElementById('referralCategoryMode' + suffix).dataset.mode);
  }
  if (referringOrg) {
    params.set('referringOrg', referringOrg);
    params.set('referringOrgMode', document.getElementById('referringOrgMode' + suffix).dataset.mode);
  }
  if (hasReferringFriend) params.set('hasReferringFriend', 'true');
  if (coachId) {
    params.set('coachId', coachId);
    params.set('coachIdMode', document.getElementById('coachIdMode' + suffix).dataset.mode);
  }
  if (minMeetings) params.set('minMeetings', minMeetings);
  if (graduatedMode) params.set('graduatedMode', graduatedMode);

  return params.toString();
}

async function fetchCohortData(suffix = '') {
  const qs = buildQueryParams(suffix);
  const res = await fetch('/api/cohort-data?' + qs);
  return res.json();
}

async function fetchAndRender() {
  const loading = document.getElementById('loading');
  const btn = document.getElementById('applyBtn');
  loading.style.display = 'block';
  btn.disabled = true;

  try {
    const dataA = await fetchCohortData('');
    lastAvgA = renderHeatmap('heatmapA', dataA);
    document.getElementById('countA').textContent = `(${dataA.totalStudents} students)`;
    updateLabel('labelA', '');

    const isCompare = document.getElementById('compareMode').checked;
    if (isCompare) {
      const dataB = await fetchCohortData('_b');
      lastAvgB = renderHeatmap('heatmapB', dataB);
      document.getElementById('countB').textContent = `(${dataB.totalStudents} students)`;
      updateLabel('labelB', '_b');
    } else {
      lastAvgB = null;
    }

    renderRetentionChart();
  } catch (err) {
    console.error('Error fetching data:', err);
  } finally {
    loading.style.display = 'none';
    btn.disabled = false;
  }
}

function updateLabel(labelId, suffix) {
  const parts = [];
  const coachSel = document.getElementById('coachId' + suffix);
  const refTypeSel = document.getElementById('referralType' + suffix);
  const refCatSel = document.getElementById('referralCategory' + suffix);
  const refOrgSel = document.getElementById('referringOrg' + suffix);

  const coachMode = document.getElementById('coachIdMode' + suffix).dataset.mode;
  const refTypeMode = document.getElementById('referralTypeMode' + suffix).dataset.mode;
  const refCatMode = document.getElementById('referralCategoryMode' + suffix).dataset.mode;
  const refOrgMode = document.getElementById('referringOrgMode' + suffix).dataset.mode;

  if (coachSel.value) parts.push('Coach ' + (coachMode === 'not' ? 'is not' : 'is') + ': ' + coachSel.options[coachSel.selectedIndex].text);
  if (refTypeSel.value) parts.push('Type ' + (refTypeMode === 'not' ? 'is not' : 'is') + ': ' + refTypeSel.value);
  if (refCatSel.value) parts.push('Category ' + (refCatMode === 'not' ? 'is not' : 'is') + ': ' + refCatSel.value);
  if (refOrgSel.value) parts.push('Org ' + (refOrgMode === 'not' ? 'is not' : 'is') + ': ' + refOrgSel.options[refOrgSel.selectedIndex].text);
  if (document.getElementById('hasReferringFriend' + suffix).checked) parts.push('Has Friend');
  const minMtg = document.getElementById('minMeetings' + suffix).value;
  if (minMtg) parts.push('Min ' + minMtg + ' meetings');

  document.getElementById(labelId).textContent = parts.length > 0 ? parts.join(' | ') : 'All Students';
}

// --- Comparison mode toggle ---
function onCompareModeToggle() {
  const on = document.getElementById('compareMode').checked;
  document.getElementById('compareFilters').style.display = on ? 'flex' : 'none';
  document.getElementById('tableB').style.display = on ? 'block' : 'none';
}

// --- Render heatmap table ---
function renderHeatmap(containerId, data) {
  const container = document.getElementById(containerId);
  if (!data.cohorts || data.cohorts.length === 0) {
    container.innerHTML = '<p style="color:#636e72;padding:20px;">No data found for the selected filters.</p>';
    return [];
  }

  // Determine max periods across all cohorts
  let maxPeriods = 0;
  for (const c of data.cohorts) {
    if (c.periods.length > maxPeriods) maxPeriods = c.periods.length;
  }

  let html = '<table class="heatmap-table"><thead><tr>';
  html += '<th>Cohort</th><th>Students</th>';
  for (let p = 1; p <= maxPeriods; p++) {
    html += `<th>M${p}</th>`;
  }
  html += '</tr></thead><tbody>';

  // Track sums for average row
  const periodSums = new Array(maxPeriods).fill(0);
  const periodCounts = new Array(maxPeriods).fill(0);

  for (const cohort of data.cohorts) {
    const monthLabel = formatMonth(cohort.month);
    html += `<tr><th>${monthLabel}</th>`;
    html += `<td class="count-cell">${cohort.total}</td>`;

    for (let p = 0; p < maxPeriods; p++) {
      if (p < cohort.periods.length) {
        const period = cohort.periods[p];
        const color = retentionColor(period.pct);
        const textColor = period.pct > 50 ? '#fff' : '#2d3436';
        html += `<td class="retention-cell" style="background:${color};color:${textColor}" `
          + `data-tooltip="${period.retained}/${cohort.total} retained (${period.pct}%)">`
          + `${period.pct}%</td>`;
        periodSums[p] += period.pct;
        periodCounts[p]++;
      } else {
        html += '<td class="na-cell"></td>';
      }
    }
    html += '</tr>';
  }

  // Summary average row
  const totalStudents = data.cohorts.reduce((sum, c) => sum + c.total, 0);
  html += `<tr class="summary-row"><th>Average</th><td class="count-cell">${totalStudents}</td>`;
  for (let p = 0; p < maxPeriods; p++) {
    if (periodCounts[p] > 0) {
      const avg = Math.round((periodSums[p] / periodCounts[p]) * 10) / 10;
      const color = retentionColor(avg);
      const textColor = avg > 50 ? '#fff' : '#2d3436';
      html += `<td class="retention-cell" style="background:${color};color:${textColor}" `
        + `data-tooltip="Average of ${periodCounts[p]} cohorts (${avg}%)">`
        + `${avg}%</td>`;
    } else {
      html += '<td class="na-cell"></td>';
    }
  }
  html += '</tr>';

  html += '</tbody></table>';
  container.innerHTML = html;

  // Attach tooltip listeners
  attachTooltips(container);

  // Return averages for chart
  const averages = [];
  for (let p = 0; p < maxPeriods; p++) {
    if (periodCounts[p] > 0) {
      averages.push(Math.round((periodSums[p] / periodCounts[p]) * 10) / 10);
    }
  }
  return averages;
}

// --- Retention Chart ---
function renderRetentionChart() {
  const panel = document.getElementById('chartPanel');
  const canvas = document.getElementById('retentionChart');

  if (!lastAvgA || lastAvgA.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';

  const maxLen = Math.max(lastAvgA.length, (lastAvgB || []).length);
  const labels = Array.from({ length: maxLen }, (_, i) => `M${i + 1}`);

  const labelA = document.getElementById('labelA').textContent;
  const datasets = [{
    label: lastAvgB ? labelA : 'Average Retention',
    data: lastAvgA,
    borderColor: '#1a5276',
    backgroundColor: 'rgba(26, 82, 118, 0.1)',
    borderWidth: 2,
    pointRadius: 3,
    tension: 0.3,
    fill: true
  }];

  if (lastAvgB && lastAvgB.length > 0) {
    const labelB = document.getElementById('labelB').textContent;
    datasets.push({
      label: labelB,
      data: lastAvgB,
      borderColor: '#e17055',
      backgroundColor: 'rgba(225, 112, 85, 0.1)',
      borderWidth: 2,
      pointRadius: 3,
      tension: 0.3,
      fill: true
    });
  }

  if (retentionChart) {
    retentionChart.destroy();
  }

  retentionChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          min: 0,
          max: 100,
          ticks: { callback: v => v + '%' },
          title: { display: true, text: 'Retention %' }
        },
        x: {
          title: { display: true, text: 'Months Since Start' }
        }
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y}%`
          }
        }
      }
    }
  });
}

function formatMonth(monthStr) {
  const [y, m] = monthStr.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[parseInt(m) - 1] + ' ' + y;
}

function retentionColor(pct) {
  // Dark blue (high retention) to light blue (low retention)
  // Interpolate between light (#dbe9f7) and dark (#1a5276)
  const light = { r: 219, g: 233, b: 247 };
  const dark = { r: 26, g: 82, b: 118 };
  const t = pct / 100;
  const r = Math.round(light.r + (dark.r - light.r) * t);
  const g = Math.round(light.g + (dark.g - light.g) * t);
  const b = Math.round(light.b + (dark.b - light.b) * t);
  return `rgb(${r},${g},${b})`;
}

// --- Breakdown ---
const BREAKDOWN_COLORS = [
  '#1a5276', '#e17055', '#00b894', '#6c5ce7', '#fdcb6e',
  '#e84393', '#0984e3', '#d63031', '#00cec9', '#636e72',
  '#2d3436', '#a29bfe', '#fab1a0', '#55efc4', '#fd79a8'
];

function onBreakdownChange() {
  const val = document.getElementById('breakdownBy').value;
  const group = document.getElementById('breakdownSelectGroup');
  const btn = document.getElementById('breakdownBtn');
  const chartPanel = document.getElementById('breakdownChartPanel');

  if (!val) {
    group.style.display = 'none';
    btn.style.display = 'none';
    chartPanel.style.display = 'none';
    return;
  }

  group.style.display = 'block';
  btn.style.display = 'inline-block';

  // Populate checkboxes
  const options = document.getElementById('breakdownOptions');
  const search = document.getElementById('breakdownSearch');
  search.value = '';

  let items = [];
  if (val === 'coach') {
    items = filtersData.coaches.map(c => ({ id: c.id, label: c.name }));
  } else if (val === 'org') {
    items = filtersData.referringOrgs.map(o => ({ id: o.id, label: o.name }));
  } else if (val === 'referralType') {
    items = filtersData.referralTypes.map(v => ({ id: v, label: v }));
  } else if (val === 'referralCategory') {
    items = filtersData.referralCategories.map(v => ({ id: v, label: v }));
  }

  options.innerHTML = items.map(item =>
    `<label data-search="${item.label.toLowerCase()}">
      <input type="checkbox" value="${item.id}"> ${item.label}
    </label>`
  ).join('');
}

function onBreakdownSearch() {
  const query = document.getElementById('breakdownSearch').value.toLowerCase();
  const labels = document.querySelectorAll('#breakdownOptions label');
  labels.forEach(label => {
    label.style.display = label.dataset.search.includes(query) ? 'flex' : 'none';
  });
}

async function fetchAndRenderBreakdown() {
  const breakdownBy = document.getElementById('breakdownBy').value;
  if (!breakdownBy) return;

  const checked = document.querySelectorAll('#breakdownOptions input:checked');
  if (checked.length === 0) return;

  const selectedIds = Array.from(checked).map(cb => cb.value).join(',');

  // Build base params (date range, minMeetings, graduatedMode)
  const params = new URLSearchParams();
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  const minMeetings = document.getElementById('minMeetings').value;
  const graduatedMode = document.getElementById('graduatedMode').value;

  if (startDate) params.set('startDate', startDate + '-01');
  if (endDate) {
    const [y, m] = endDate.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    params.set('endDate', `${endDate}-${lastDay}`);
  }
  if (minMeetings) params.set('minMeetings', minMeetings);
  if (graduatedMode) params.set('graduatedMode', graduatedMode);
  params.set('breakdownBy', breakdownBy);
  params.set('selectedIds', selectedIds);

  const loading = document.getElementById('loading');
  const btn = document.getElementById('breakdownBtn');
  loading.style.display = 'block';
  btn.disabled = true;

  try {
    const res = await fetch('/api/breakdown-data?' + params.toString());
    const data = await res.json();
    renderBreakdownChart(data.series);
  } catch (err) {
    console.error('Error fetching breakdown data:', err);
  } finally {
    loading.style.display = 'none';
    btn.disabled = false;
  }
}

function renderBreakdownChart(series) {
  const panel = document.getElementById('breakdownChartPanel');
  const canvas = document.getElementById('breakdownChart');

  if (!series || series.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';

  const maxLen = Math.max(...series.map(s => s.averages.length));
  const labels = Array.from({ length: maxLen }, (_, i) => `M${i + 1}`);

  const datasets = series.map((s, i) => ({
    label: `${s.name} (${s.studentCount})`,
    data: s.averages,
    borderColor: BREAKDOWN_COLORS[i % BREAKDOWN_COLORS.length],
    backgroundColor: 'transparent',
    borderWidth: 2,
    pointRadius: 3,
    tension: 0.3,
    fill: false
  }));

  if (breakdownChart) breakdownChart.destroy();

  breakdownChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          min: 0,
          max: 100,
          ticks: { callback: v => v + '%' },
          title: { display: true, text: 'Retention %' }
        },
        x: {
          title: { display: true, text: 'Months Since Start' }
        }
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y}%`
          }
        },
        legend: {
          position: 'bottom',
          labels: { boxWidth: 12, padding: 15 }
        }
      }
    }
  });
}

// --- Tooltips ---
let tooltipEl = null;

function attachTooltips(container) {
  container.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.retention-cell');
    if (!cell) return;
    const text = cell.dataset.tooltip;
    if (!text) return;

    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'cell-tooltip';
      document.body.appendChild(tooltipEl);
    }
    tooltipEl.textContent = text;
    tooltipEl.style.display = 'block';
    positionTooltip(e);
  });

  container.addEventListener('mousemove', (e) => {
    if (tooltipEl && tooltipEl.style.display === 'block') positionTooltip(e);
  });

  container.addEventListener('mouseout', (e) => {
    if (!e.target.closest('.retention-cell') && tooltipEl) {
      tooltipEl.style.display = 'none';
    }
  });
}

function positionTooltip(e) {
  if (!tooltipEl) return;
  tooltipEl.style.left = (e.clientX + 12) + 'px';
  tooltipEl.style.top = (e.clientY - 30) + 'px';
}
