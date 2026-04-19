// Acquisition & Capacity report — frontend logic
// One main chart: Souled Students over time, with toggleable overlays for
// Total Capacity, Current Capacity, Current Capacity buffered, New Registrations, Cost per Signup.

let studentsChart = null;
let studentsGranularity = 'weekly';
const enabledOverlays = new Set();

const OVERLAY_STYLE = {
  capacity:                { label: 'Total Capacity',           color: '#00b894', dash: [6, 4], axis: 'y' },
  currentCapacity:         { label: 'Current Capacity',         color: '#fd7e14', dash: [],     axis: 'y' },
  currentCapacityBuffered: { label: 'Current Capacity buffered', color: '#ffa94d', dash: [4, 3], axis: 'y' },
  registrations:           { label: 'New Registrations',         color: '#6c5ce7', dash: [],     axis: 'y1', unit: 'regs' },
  cpl:                     { label: 'Cost per Signup ($)',       color: '#d63031', dash: [],     axis: 'y1', unit: 'usd' }
};

async function loadStudentsChart() {
  const startInput = document.getElementById('studentsStart');
  const endInput = document.getElementById('studentsEnd');
  const start = startInput.value;
  const end = endInput.value;

  try {
    // Always fetch the matched-students series; conditionally fetch overlays
    const fetches = [
      fetch(`/api/matched-students-history?start=${start}&end=${end}&granularity=${studentsGranularity}`).then(r => r.json())
    ];
    if (enabledOverlays.size > 0) {
      // 'currentCapacityBuffered' is computed client-side from currentCapacity − buffer.
      // Make sure the backend is asked for currentCapacity whenever buffered is enabled.
      const apiInclude = new Set(enabledOverlays);
      if (apiInclude.has('currentCapacityBuffered')) {
        apiInclude.add('currentCapacity'); // gives us both the value and the buffer series
        apiInclude.delete('currentCapacityBuffered'); // not a backend key
      }
      const include = [...apiInclude].join(',');
      fetches.push(
        fetch(`/api/student-overlays?start=${start}&end=${end}&granularity=${studentsGranularity}&include=${include}`).then(r => r.json())
      );
    }
    const [students, overlaysPayload] = await Promise.all(fetches);
    if (students.error) throw new Error(students.error);

    document.getElementById('currentMatchedValue').textContent =
      students.currentValue !== null ? Number(students.currentValue).toLocaleString() : '—';
    if (students.earliestAvailable) startInput.min = students.earliestAvailable;

    // Build datasets: students always first, then any overlays
    const labels = students.data.map(p => p.date);
    const datasets = [{
      label: 'Souled Students with a Coach',
      data: students.data.map(p => p.value),
      borderColor: '#0984e3',
      backgroundColor: 'rgba(9, 132, 227, 0.1)',
      fill: true,
      tension: 0.25,
      pointRadius: studentsGranularity === 'daily' ? 0 : 3,
      pointHoverRadius: 5,
      borderWidth: 2,
      yAxisID: 'y'
    }];

    // Per-date map of policy buffer (active coach count). Used for the buffered overlay
    // and for the "Available spots" tooltip footer when relevant.
    const bufferByDate = (overlaysPayload && overlaysPayload.series && overlaysPayload.series.buffer)
      ? new Map(overlaysPayload.series.buffer.map(p => [p.date, p.value]))
      : new Map();
    const currentCapByDate = (overlaysPayload && overlaysPayload.series && overlaysPayload.series.currentCapacity)
      ? new Map(overlaysPayload.series.currentCapacity.map(p => [p.date, p.value]))
      : new Map();

    if (overlaysPayload && overlaysPayload.series) {
      for (const key of ['capacity', 'currentCapacity', 'currentCapacityBuffered', 'registrations', 'cpl']) {
        if (!enabledOverlays.has(key)) continue;
        const style = OVERLAY_STYLE[key];

        // Source values come from the API for everything except the buffered variant,
        // which is computed locally as currentCapacity − buffer.
        let sourceMap;
        if (key === 'currentCapacityBuffered') {
          sourceMap = new Map();
          for (const [d, capVal] of currentCapByDate.entries()) {
            const b = bufferByDate.get(d) ?? 0;
            sourceMap.set(d, Math.max(0, capVal - b));
          }
        } else {
          if (!overlaysPayload.series[key]) continue;
          sourceMap = new Map(overlaysPayload.series[key].map(p => [p.date, p.value]));
        }

        datasets.push({
          label: style.label,
          data: labels.map(d => sourceMap.has(d) ? sourceMap.get(d) : null),
          borderColor: style.color,
          backgroundColor: style.color + '20',
          borderDash: style.dash,
          fill: false,
          tension: 0.25,
          pointRadius: studentsGranularity === 'daily' ? 0 : 3,
          pointHoverRadius: 5,
          borderWidth: 2,
          yAxisID: style.axis,
          // CPL: gaps mean ads paused (no spend) — show as visible breaks. Others bridge.
          spanGaps: key !== 'cpl'
        });
      }
    }

    const showRightAxis = enabledOverlays.has('cpl') || enabledOverlays.has('registrations');
    const rightAxisLabel = (enabledOverlays.has('cpl') && enabledOverlays.has('registrations'))
      ? 'Cost per Signup ($) / Registrations'
      : enabledOverlays.has('cpl') ? 'Cost per Signup ($)' : 'New Registrations';

    const ctx = document.getElementById('studentsChart').getContext('2d');
    if (studentsChart) studentsChart.destroy();
    studentsChart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: datasets.length > 1, position: 'bottom' },
          tooltip: {
            callbacks: {
              title: items => items[0].label,
              label: item => {
                const v = item.parsed.y;
                if (v === null || v === undefined) return null;
                const rounded = Math.round(Number(v));
                if (item.dataset.label === 'Cost per Signup ($)') {
                  return ` ${item.dataset.label}: $${rounded.toLocaleString()}`;
                }
                if (item.dataset.label === 'New Registrations') {
                  return ` ${item.dataset.label}: ${rounded.toLocaleString()} this ${studentsGranularity === 'monthly' ? 'month' : studentsGranularity === 'weekly' ? 'week' : 'day'}`;
                }
                return ` ${item.dataset.label}: ${rounded.toLocaleString()}`;
              },
              footer: items => {
                const studentsItem = items.find(i => i.dataset.label === 'Souled Students with a Coach');
                if (!studentsItem) return undefined;
                const bufItem = items.find(i => i.dataset.label === 'Current Capacity buffered');
                const rawItem = items.find(i => i.dataset.label === 'Current Capacity');
                const lines = [];
                const sv = studentsItem.parsed.y;
                if (sv === null || sv === undefined) return undefined;
                if (rawItem && rawItem.parsed.y != null) {
                  lines.push(`Available spots: ${Math.round(rawItem.parsed.y - sv).toLocaleString()}`);
                }
                if (bufItem && bufItem.parsed.y != null) {
                  lines.push(`Available (above buffer): ${Math.round(bufItem.parsed.y - sv).toLocaleString()}`);
                }
                return lines.length ? lines : undefined;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
            grid: { display: false }
          },
          y: {
            position: 'left',
            beginAtZero: false,
            title: { display: true, text: 'Students / Capacity' },
            ticks: { callback: v => Number(v).toLocaleString() }
          },
          y1: {
            position: 'right',
            display: showRightAxis,
            beginAtZero: true,
            title: { display: true, text: rightAxisLabel },
            grid: { drawOnChartArea: false },
            ticks: {
              callback: v => {
                if (enabledOverlays.has('cpl')) return '$' + Number(v).toLocaleString();
                return Number(v).toLocaleString();
              }
            }
          }
        }
      }
    });
  } catch (err) {
    console.error('Failed to load students chart:', err);
    document.getElementById('currentMatchedValue').textContent = 'Error';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Init date pickers (defaults: Sept 1 2025 → today, max = today)
  const startInput = document.getElementById('studentsStart');
  const endInput = document.getElementById('studentsEnd');
  startInput.value = '2025-09-01';
  endInput.value = new Date().toISOString().slice(0, 10);
  endInput.max = endInput.value;

  // Date pickers
  startInput.addEventListener('change', loadStudentsChart);
  endInput.addEventListener('change', loadStudentsChart);

  // Granularity buttons
  document.querySelectorAll('.gran-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.gran-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      studentsGranularity = btn.dataset.gran;
      loadStudentsChart();
    });
  });

  // Overlay checkboxes
  document.querySelectorAll('.overlay-controls input[data-overlay]').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.overlay;
      if (cb.checked) enabledOverlays.add(key);
      else enabledOverlays.delete(key);
      loadStudentsChart();
    });
  });

  // Initial render
  loadStudentsChart();
});
