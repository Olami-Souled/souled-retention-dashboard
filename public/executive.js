// Executive Report - Frontend Logic

async function fetchExecutiveData(fy) {
  const res = await fetch(`/api/executive-data?fy=${fy}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString();
}

function pctChange(current, previous) {
  if (!current || !previous) return '';
  const pct = Math.round(((current - previous) / previous) * 100);
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct}%`;
}

function pctClass(current, previous) {
  if (!current || !previous) return '';
  return current >= previous ? 'positive' : 'negative';
}

function pctCellClass(current, previous) {
  if (!current || !previous) return '';
  return current >= previous ? 'pos' : 'neg';
}

function buildCardsView(data, compareData) {
  const container = document.getElementById('cards-view');
  const prevLabel = compareData ? `vs ${compareData.fy}` : '';

  function card(label, value, prevValue, opts = {}) {
    const cls = opts.small ? 'kpi-card small' : 'kpi-card';
    const highlight = opts.highlight ? ' highlight' : '';
    let changeHtml = '';
    if (prevValue !== undefined && prevValue !== null && value !== null) {
      const pct = pctChange(value, prevValue);
      const pcl = pctClass(value, prevValue);
      if (pct) changeHtml = `<div class="kpi-change ${pcl}">${pct} ${prevLabel}</div>`;
    }
    return `<div class="${cls}${highlight}">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${fmt(value)}</div>
      ${changeHtml}
    </div>`;
  }

  const c = data.coaching;
  const pc = compareData?.coaching;
  const sg = data.spiritualGrowth;
  const psg = compareData?.spiritualGrowth;
  const g = data.graduation;
  const pg = compareData?.graduation;
  const ev = data.events;
  const pev = compareData?.events;
  const at = data.allTime;

  container.innerHTML = `
    <section class="kpi-section">
      <h2 class="section-title">Coaching Activity</h2>
      <div class="kpi-grid">
        ${card('Students who met with a coach', c.studentsMetCoach, pc?.studentsMetCoach)}
        ${card('One on Ones', c.totalOneOnOnes, pc?.totalOneOnOnes)}
        ${card('Avg Weekly One on Ones', c.avgWeeklyOneOnOnes, pc?.avgWeeklyOneOnOnes)}
      </div>
    </section>

    <section class="kpi-section">
      <h2 class="section-title">One-on-One Buckets</h2>
      <div class="kpi-grid">
        ${card('1-3 meetings', c.tpBuckets['1-3'], pc?.tpBuckets?.['1-3'], {small: true})}
        ${card('4-6 meetings', c.tpBuckets['4-6'], pc?.tpBuckets?.['4-6'], {small: true})}
        ${card('7-9 meetings', c.tpBuckets['7-9'], pc?.tpBuckets?.['7-9'], {small: true})}
        ${card('10+ meetings', c.tpBuckets['10+'], pc?.tpBuckets?.['10+'], {small: true})}
        ${card('7+ Continuous', c.tpContinuous, pc?.tpContinuous, {small: true, highlight: true})}
      </div>
    </section>

    <section class="kpi-section">
      <h2 class="section-title">Interaction Buckets</h2>
      <div class="kpi-grid">
        ${card('1-3 interactions', c.intBuckets['1-3'], pc?.intBuckets?.['1-3'], {small: true})}
        ${card('4-6 interactions', c.intBuckets['4-6'], pc?.intBuckets?.['4-6'], {small: true})}
        ${card('7-9 interactions', c.intBuckets['7-9'], pc?.intBuckets?.['7-9'], {small: true})}
        ${card('10+ interactions', c.intBuckets['10+'], pc?.intBuckets?.['10+'], {small: true})}
        ${card('7+ Continuous', c.intContinuous, pc?.intContinuous, {small: true, highlight: true})}
      </div>
    </section>

    <section class="kpi-section">
      <h2 class="section-title">Trips &amp; Seminary</h2>
      <div class="kpi-grid">
        ${card('L2 Trip Participants', data.l2Trips.participants, compareData?.l2Trips?.participants)}
        ${card('Seminary Placements', data.seminary.placements, compareData?.seminary?.placements)}
      </div>
    </section>

    <section class="kpi-section">
      <h2 class="section-title">Spiritual Growth</h2>
      <div class="kpi-grid">
        ${card('Became SO (Shabbat Observant)', sg.so, psg?.so)}
        ${card('Became STAM (Fully Observant)', sg.stam, psg?.stam)}
        ${card('Unique SO/STAM', sg.uniqueSOSTAM, psg?.uniqueSOSTAM, {highlight: true})}
      </div>
    </section>

    <section class="kpi-section">
      <h2 class="section-title">Step Forward Commitments</h2>
      <div class="kpi-grid">
        ${card('Became Shomer Kashrus', sg.kashrus, psg?.kashrus, {small: true})}
        ${card('Became Shomer Tznius', sg.tznius, psg?.tznius, {small: true})}
        ${card('Committed to Marry Jewish', sg.marryJewish, psg?.marryJewish, {small: true})}
      </div>
    </section>

    <section class="kpi-section">
      <h2 class="section-title">Graduation Paths</h2>
      <div class="kpi-grid">
        ${card('Graduated to In Person Learning', g.inPersonLearning, pg?.inPersonLearning, {small: true})}
        ${card('Graduated to Long Term Seminary', g.longTermSeminary, pg?.longTermSeminary, {small: true})}
        ${card('Graduated to Orthodox Conversion', g.orthodoxConversion, pg?.orthodoxConversion, {small: true})}
      </div>
    </section>

    <section class="kpi-section">
      <h2 class="section-title">Classes &amp; Events</h2>
      <div class="kpi-grid">
        ${card('Video Classes Watched', ev.videoClassesWatched, pev?.videoClassesWatched, {small: true})}
        ${card('Video Class Watchers', ev.videoClassWatchers, pev?.videoClassWatchers, {small: true})}
        ${card('Live Zoom Attendances', ev.liveZoomAttendances, pev?.liveZoomAttendances, {small: true})}
        ${card('Live Zoom Attendees', ev.liveZoomAttendees, pev?.liveZoomAttendees, {small: true})}
        ${card('Coach-Led Courses', ev.coachLedCourses, pev?.coachLedCourses, {small: true})}
        ${card('CLC Students', ev.clcStudents, pev?.clcStudents, {small: true})}
        ${card('Experiences by Coaches', ev.experiencesByCoaches, pev?.experiencesByCoaches, {small: true})}
        ${card('Students at Experiences', ev.studentsAtExperiences, pev?.studentsAtExperiences, {small: true})}
        ${card('Weekday Event Attendances', ev.weekdayEventAttendances, pev?.weekdayEventAttendances, {small: true})}
        ${card('Weekday Event Attendees', ev.weekdayEventAttendees, pev?.weekdayEventAttendees, {small: true})}
        ${card('Shabbaton Attendances', ev.shabbatonAttendances, pev?.shabbatonAttendances, {small: true})}
        ${card('Shabbaton Attendees', ev.shabbatonAttendees, pev?.shabbatonAttendees, {small: true})}
      </div>
    </section>

    <section class="kpi-section alltime">
      <h2 class="section-title">All Time Numbers</h2>
      <div class="kpi-grid">
        ${card('Students Registered for Souled', at.registeredForSouled)}
        ${card('Students Who Met with a Coach', at.metWithCoach)}
        ${card('Met with Coach 3+ Times', at.metWithCoach3Plus)}
      </div>
    </section>
  `;
}

function buildTableView(data, compareData) {
  const container = document.getElementById('table-view');
  const c = data.coaching;
  const pc = compareData?.coaching;
  const sg = data.spiritualGrowth;
  const psg = compareData?.spiritualGrowth;
  const g = data.graduation;
  const pg = compareData?.graduation;
  const ev = data.events;
  const pev = compareData?.events;
  const at = data.allTime;

  const prevFy = compareData?.fy || 'Previous';

  function row(label, val, prevVal, opts = {}) {
    const cls = opts.highlight ? ' class="highlight-row"' : '';
    const pct = pctChange(val, prevVal);
    const pcl = pctCellClass(val, prevVal);
    return `<tr${cls}><td>${label}</td><td>${fmt(val)}</td><td>${fmt(prevVal)}</td><td class="${pcl}">${pct}</td></tr>`;
  }
  function section(title, cls) {
    return `<tr class="section-header${cls ? ' ' + cls : ''}"><td colspan="4">${title}</td></tr>`;
  }

  container.innerHTML = `
    <div class="exec-table-wrapper">
      <table class="exec-table">
        <thead><tr>
          <th>Metric</th>
          <th>${data.fy} (Current)</th>
          <th>${prevFy}</th>
          <th>% Change</th>
        </tr></thead>
        <tbody>
          ${section('Coaching Activity')}
          ${row('Students who met with a coach', c.studentsMetCoach, pc?.studentsMetCoach)}
          ${row('One on Ones', c.totalOneOnOnes, pc?.totalOneOnOnes)}
          ${row('Avg Weekly One on Ones', c.avgWeeklyOneOnOnes, pc?.avgWeeklyOneOnOnes)}

          ${section('One-on-One Buckets')}
          ${row('Students had 1-3', c.tpBuckets['1-3'], pc?.tpBuckets?.['1-3'])}
          ${row('Students had 4-6', c.tpBuckets['4-6'], pc?.tpBuckets?.['4-6'])}
          ${row('Students had 7-9', c.tpBuckets['7-9'], pc?.tpBuckets?.['7-9'])}
          ${row('Students had 10+', c.tpBuckets['10+'], pc?.tpBuckets?.['10+'])}
          ${row('7+ Continuous', c.tpContinuous, pc?.tpContinuous, {highlight: true})}

          ${section('Interaction Buckets')}
          ${row('Students had 1-3', c.intBuckets['1-3'], pc?.intBuckets?.['1-3'])}
          ${row('Students had 4-6', c.intBuckets['4-6'], pc?.intBuckets?.['4-6'])}
          ${row('Students had 7-9', c.intBuckets['7-9'], pc?.intBuckets?.['7-9'])}
          ${row('Students had 10+', c.intBuckets['10+'], pc?.intBuckets?.['10+'])}
          ${row('7+ Continuous', c.intContinuous, pc?.intContinuous, {highlight: true})}

          ${section('Trips & Seminary')}
          ${row('L2 Trip Participants', data.l2Trips.participants, compareData?.l2Trips?.participants)}
          ${row('Seminary Placements', data.seminary.placements, compareData?.seminary?.placements)}

          ${section('Spiritual Growth')}
          ${row('SO (Shabbat Observant)', sg.so, psg?.so)}
          ${row('STAM (Fully Observant)', sg.stam, psg?.stam)}
          ${row('Unique SO/STAM', sg.uniqueSOSTAM, psg?.uniqueSOSTAM, {highlight: true})}

          ${section('Step Forward Commitments')}
          ${row('Became Shomer Kashrus', sg.kashrus, psg?.kashrus)}
          ${row('Became Shomer Tznius', sg.tznius, psg?.tznius)}
          ${row('Committed to Marry Jewish', sg.marryJewish, psg?.marryJewish)}

          ${section('Graduation Paths')}
          ${row('Graduated to In Person Learning', g.inPersonLearning, pg?.inPersonLearning)}
          ${row('Graduated to Long Term Seminary', g.longTermSeminary, pg?.longTermSeminary)}
          ${row('Graduated to Orthodox Conversion', g.orthodoxConversion, pg?.orthodoxConversion)}

          ${section('Classes & Events')}
          ${row('Video Classes Watched', ev.videoClassesWatched, pev?.videoClassesWatched)}
          ${row('Video Class Watchers', ev.videoClassWatchers, pev?.videoClassWatchers)}
          ${row('Live Zoom Attendances', ev.liveZoomAttendances, pev?.liveZoomAttendances)}
          ${row('Live Zoom Attendees', ev.liveZoomAttendees, pev?.liveZoomAttendees)}
          ${row('Coach-Led Courses', ev.coachLedCourses, pev?.coachLedCourses)}
          ${row('CLC Students', ev.clcStudents, pev?.clcStudents)}
          ${row('Experiences by Coaches', ev.experiencesByCoaches, pev?.experiencesByCoaches)}
          ${row('Students at Experiences', ev.studentsAtExperiences, pev?.studentsAtExperiences)}
          ${row('Weekday Event Attendances', ev.weekdayEventAttendances, pev?.weekdayEventAttendances)}
          ${row('Weekday Event Attendees', ev.weekdayEventAttendees, pev?.weekdayEventAttendees)}
          ${row('Shabbaton Attendances', ev.shabbatonAttendances, pev?.shabbatonAttendances)}
          ${row('Shabbaton Attendees', ev.shabbatonAttendees, pev?.shabbatonAttendees)}

          ${section('All Time Numbers', 'alltime-header')}
          ${row('Students Registered for Souled', at.registeredForSouled)}
          ${row('Students Who Met with a Coach', at.metWithCoach)}
          ${row('Met with Coach 3+ Times', at.metWithCoach3Plus)}
        </tbody>
      </table>
    </div>
  `;
}

// --- Loading state ---
function showLoading() {
  document.getElementById('cards-view').innerHTML = '<div style="text-align:center;padding:40px;color:#636e72;">Loading data from Salesforce...</div>';
  document.getElementById('table-view').innerHTML = '<div style="text-align:center;padding:40px;color:#636e72;">Loading data from Salesforce...</div>';
}

function showError(msg) {
  const html = `<div style="text-align:center;padding:40px;color:#d63031;">Error: ${msg}</div>`;
  document.getElementById('cards-view').innerHTML = html;
  document.getElementById('table-view').innerHTML = html;
}

// --- Main ---
let currentData = null;
let compareData = null;

async function loadData() {
  const fySelect = document.getElementById('fySelect');
  const fy = fySelect.value;

  showLoading();

  try {
    if (fy === 'both') {
      const [d26, d25] = await Promise.all([
        fetchExecutiveData('FY26'),
        fetchExecutiveData('FY25')
      ]);
      currentData = d26;
      compareData = d25;
    } else {
      currentData = await fetchExecutiveData(fy);
      // Load previous FY for comparison
      const prevFy = fy === 'FY26' ? 'FY25' : 'FY24';
      try {
        compareData = await fetchExecutiveData(prevFy);
      } catch {
        compareData = null;
      }
    }

    buildCardsView(currentData, compareData);
    buildTableView(currentData, compareData);
  } catch (err) {
    showError(err.message);
  }
}

async function downloadExcel() {
  const btn = document.getElementById('downloadBtn');
  btn.disabled = true;
  btn.textContent = 'Downloading...';

  try {
    const [fy26, fy25] = await Promise.all([
      fetchExecutiveData('FY26'),
      fetchExecutiveData('FY25')
    ]);

    const rows = [
      ['Souled Executive Report', '', '', ''],
      ['Generated', new Date().toLocaleDateString(), '', ''],
      [],
      ['Metric', 'FY26', 'FY25', '% Change'],
      [],
      ['COACHING ACTIVITY'],
      ['Students who met with a coach', fy26.coaching.studentsMetCoach, fy25.coaching.studentsMetCoach],
      ['One on Ones', fy26.coaching.totalOneOnOnes, fy25.coaching.totalOneOnOnes],
      ['Avg Weekly One on Ones', fy26.coaching.avgWeeklyOneOnOnes, fy25.coaching.avgWeeklyOneOnOnes],
      [],
      ['ONE-ON-ONE BUCKETS'],
      ['Students had 1-3', fy26.coaching.tpBuckets['1-3'], fy25.coaching.tpBuckets['1-3']],
      ['Students had 4-6', fy26.coaching.tpBuckets['4-6'], fy25.coaching.tpBuckets['4-6']],
      ['Students had 7-9', fy26.coaching.tpBuckets['7-9'], fy25.coaching.tpBuckets['7-9']],
      ['Students had 10+', fy26.coaching.tpBuckets['10+'], fy25.coaching.tpBuckets['10+']],
      ['7+ Continuous', fy26.coaching.tpContinuous, fy25.coaching.tpContinuous],
      [],
      ['INTERACTION BUCKETS'],
      ['Students had 1-3', fy26.coaching.intBuckets['1-3'], fy25.coaching.intBuckets['1-3']],
      ['Students had 4-6', fy26.coaching.intBuckets['4-6'], fy25.coaching.intBuckets['4-6']],
      ['Students had 7-9', fy26.coaching.intBuckets['7-9'], fy25.coaching.intBuckets['7-9']],
      ['Students had 10+', fy26.coaching.intBuckets['10+'], fy25.coaching.intBuckets['10+']],
      ['7+ Continuous', fy26.coaching.intContinuous, fy25.coaching.intContinuous],
      [],
      ['TRIPS & SEMINARY'],
      ['L2 Trip Participants', fy26.l2Trips.participants, fy25.l2Trips.participants],
      ['Seminary Placements', fy26.seminary.placements, fy25.seminary.placements],
      [],
      ['SPIRITUAL GROWTH'],
      ['Became SO (Shabbat Observant)', fy26.spiritualGrowth.so, fy25.spiritualGrowth.so],
      ['Became STAM (Fully Observant)', fy26.spiritualGrowth.stam, fy25.spiritualGrowth.stam],
      ['Unique SO/STAM', fy26.spiritualGrowth.uniqueSOSTAM, fy25.spiritualGrowth.uniqueSOSTAM],
      [],
      ['STEP FORWARD COMMITMENTS'],
      ['Became Shomer Kashrus', fy26.spiritualGrowth.kashrus, fy25.spiritualGrowth.kashrus],
      ['Became Shomer Tznius', fy26.spiritualGrowth.tznius, fy25.spiritualGrowth.tznius],
      ['Committed to Marry Jewish', fy26.spiritualGrowth.marryJewish, fy25.spiritualGrowth.marryJewish],
      [],
      ['GRADUATION PATHS'],
      ['Graduated to In Person Learning', fy26.graduation.inPersonLearning, fy25.graduation.inPersonLearning],
      ['Graduated to Long Term Seminary', fy26.graduation.longTermSeminary, fy25.graduation.longTermSeminary],
      ['Graduated to Orthodox Conversion', fy26.graduation.orthodoxConversion, fy25.graduation.orthodoxConversion],
      [],
      ['CLASSES & EVENTS'],
      ['Video Classes Watched', fy26.events.videoClassesWatched, fy25.events.videoClassesWatched],
      ['Video Class Watchers', fy26.events.videoClassWatchers, fy25.events.videoClassWatchers],
      ['Live Zoom Attendances', fy26.events.liveZoomAttendances, fy25.events.liveZoomAttendances],
      ['Live Zoom Attendees', fy26.events.liveZoomAttendees, fy25.events.liveZoomAttendees],
      ['Coach-Led Courses', fy26.events.coachLedCourses, fy25.events.coachLedCourses],
      ['CLC Students', fy26.events.clcStudents, fy25.events.clcStudents],
      ['Experiences by Coaches', fy26.events.experiencesByCoaches, fy25.events.experiencesByCoaches],
      ['Students at Experiences', fy26.events.studentsAtExperiences, fy25.events.studentsAtExperiences],
      ['Weekday Event Attendances', fy26.events.weekdayEventAttendances, fy25.events.weekdayEventAttendances],
      ['Weekday Event Attendees', fy26.events.weekdayEventAttendees, fy25.events.weekdayEventAttendees],
      ['Shabbaton Attendances', fy26.events.shabbatonAttendances, fy25.events.shabbatonAttendances],
      ['Shabbaton Attendees', fy26.events.shabbatonAttendees, fy25.events.shabbatonAttendees],
      [],
      ['ALL TIME NUMBERS'],
      ['Students Registered for Souled', fy26.allTime.registeredForSouled],
      ['Students Who Met with a Coach', fy26.allTime.metWithCoach],
      ['Met with Coach 3+ Times', fy26.allTime.metWithCoach3Plus],
    ];

    // Add % change formulas for data rows
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.length >= 3 && typeof r[1] === 'number' && typeof r[2] === 'number' && r[2] !== 0) {
        r[3] = (r[1] - r[2]) / r[2];
      }
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);

    // Column widths
    ws['!cols'] = [{ wch: 35 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];

    // Format % change column as percentage
    for (let i = 0; i < rows.length; i++) {
      const cell = ws[XLSX.utils.encode_cell({ r: i, c: 3 })];
      if (cell && typeof cell.v === 'number') {
        cell.z = '0%';
      }
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Executive Report');
    XLSX.writeFile(wb, `Souled_Executive_Report_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (err) {
    alert('Download failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download Excel';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Design toggle
  document.querySelectorAll('.design-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.design-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const design = btn.dataset.design;
      document.getElementById('cards-view').style.display = design === 'cards' ? 'block' : 'none';
      document.getElementById('table-view').style.display = design === 'table' ? 'block' : 'none';
    });
  });

  // Download button
  document.getElementById('downloadBtn').addEventListener('click', downloadExcel);

  // FY selector
  document.getElementById('fySelect').addEventListener('change', loadData);

  // Initial load
  loadData();
});
