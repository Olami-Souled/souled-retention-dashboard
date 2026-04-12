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

function buildCardsView(data, compareData, sideBySide) {
  const container = document.getElementById('cards-view');

  if (sideBySide && compareData) {
    buildSideBySideCards(container, data, compareData);
    return;
  }

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

function buildSideBySideCards(container, data, compareData) {
  const fyA = data.fy || 'FY26';
  const fyB = compareData.fy || 'FY25';

  function dualCard(label, valA, valB, opts = {}) {
    const cls = opts.small ? 'kpi-card-dual small' : 'kpi-card-dual';
    const highlight = opts.highlight ? ' highlight' : '';
    const pct = pctChange(valA, valB);
    const pcl = pctClass(valA, valB);
    const changeHtml = pct ? `<div class="dual-change ${pcl}">${pct}</div>` : '';
    return `<div class="${cls}${highlight}">
      <div class="kpi-label">${label}</div>
      <div class="dual-values">
        <div class="dual-col">
          <div class="dual-fy-label">${fyA}</div>
          <div class="dual-value">${fmt(valA)}</div>
        </div>
        <div class="dual-col">
          <div class="dual-fy-label">${fyB}</div>
          <div class="dual-value prev">${fmt(valB)}</div>
        </div>
        ${changeHtml}
      </div>
    </div>`;
  }

  const c = data.coaching, pc = compareData.coaching;
  const sg = data.spiritualGrowth, psg = compareData.spiritualGrowth;
  const g = data.graduation, pg = compareData.graduation;
  const ev = data.events, pev = compareData.events;
  const at = data.allTime;

  container.innerHTML = `
    <section class="kpi-section">
      <h2 class="section-title">Coaching Activity</h2>
      <div class="kpi-grid-dual">
        ${dualCard('Students who met with a coach', c.studentsMetCoach, pc.studentsMetCoach)}
        ${dualCard('One on Ones', c.totalOneOnOnes, pc.totalOneOnOnes)}
        ${dualCard('Avg Weekly One on Ones', c.avgWeeklyOneOnOnes, pc.avgWeeklyOneOnOnes)}
      </div>
    </section>

    <section class="kpi-section">
      <h2 class="section-title">One-on-One Buckets</h2>
      <div class="kpi-grid-dual">
        ${dualCard('1-3 meetings', c.tpBuckets['1-3'], pc.tpBuckets?.['1-3'], {small: true})}
        ${dualCard('4-6 meetings', c.tpBuckets['4-6'], pc.tpBuckets?.['4-6'], {small: true})}
        ${dualCard('7-9 meetings', c.tpBuckets['7-9'], pc.tpBuckets?.['7-9'], {small: true})}
        ${dualCard('10+ meetings', c.tpBuckets['10+'], pc.tpBuckets?.['10+'], {small: true})}
        ${dualCard('7+ Continuous', c.tpContinuous, pc.tpContinuous, {small: true, highlight: true})}
      </div>
    </section>

    <section class="kpi-section">
      <h2 class="section-title">Interaction Buckets</h2>
      <div class="kpi-grid-dual">
        ${dualCard('1-3 interactions', c.intBuckets['1-3'], pc.intBuckets?.['1-3'], {small: true})}
        ${dualCard('4-6 interactions', c.intBuckets['4-6'], pc.intBuckets?.['4-6'], {small: true})}
        ${dualCard('7-9 interactions', c.intBuckets['7-9'], pc.intBuckets?.['7-9'], {small: true})}
        ${dualCard('10+ interactions', c.intBuckets['10+'], pc.intBuckets?.['10+'], {small: true})}
        ${dualCard('7+ Continuous', c.intContinuous, pc.intContinuous, {small: true, highlight: true})}
      </div>
    </section>

    <section class="kpi-section">
      <h2 class="section-title">Trips &amp; Seminary</h2>
      <div class="kpi-grid-dual">
        ${dualCard('L2 Trip Participants', data.l2Trips.participants, compareData.l2Trips?.participants)}
        ${dualCard('Seminary Placements', data.seminary.placements, compareData.seminary?.placements)}
      </div>
    </section>

    <section class="kpi-section">
      <h2 class="section-title">Spiritual Growth</h2>
      <div class="kpi-grid-dual">
        ${dualCard('Became SO (Shabbat Observant)', sg.so, psg.so)}
        ${dualCard('Became STAM (Fully Observant)', sg.stam, psg.stam)}
        ${dualCard('Unique SO/STAM', sg.uniqueSOSTAM, psg.uniqueSOSTAM, {highlight: true})}
      </div>
    </section>

    <section class="kpi-section">
      <h2 class="section-title">Step Forward Commitments</h2>
      <div class="kpi-grid-dual">
        ${dualCard('Became Shomer Kashrus', sg.kashrus, psg.kashrus, {small: true})}
        ${dualCard('Became Shomer Tznius', sg.tznius, psg.tznius, {small: true})}
        ${dualCard('Committed to Marry Jewish', sg.marryJewish, psg.marryJewish, {small: true})}
      </div>
    </section>

    <section class="kpi-section">
      <h2 class="section-title">Graduation Paths</h2>
      <div class="kpi-grid-dual">
        ${dualCard('Graduated to In Person Learning', g.inPersonLearning, pg.inPersonLearning, {small: true})}
        ${dualCard('Graduated to Long Term Seminary', g.longTermSeminary, pg.longTermSeminary, {small: true})}
        ${dualCard('Graduated to Orthodox Conversion', g.orthodoxConversion, pg.orthodoxConversion, {small: true})}
      </div>
    </section>

    <section class="kpi-section">
      <h2 class="section-title">Classes &amp; Events</h2>
      <div class="kpi-grid-dual">
        ${dualCard('Video Classes Watched', ev.videoClassesWatched, pev.videoClassesWatched, {small: true})}
        ${dualCard('Video Class Watchers', ev.videoClassWatchers, pev.videoClassWatchers, {small: true})}
        ${dualCard('Live Zoom Attendances', ev.liveZoomAttendances, pev.liveZoomAttendances, {small: true})}
        ${dualCard('Live Zoom Attendees', ev.liveZoomAttendees, pev.liveZoomAttendees, {small: true})}
        ${dualCard('Coach-Led Courses', ev.coachLedCourses, pev.coachLedCourses, {small: true})}
        ${dualCard('CLC Students', ev.clcStudents, pev.clcStudents, {small: true})}
        ${dualCard('Experiences by Coaches', ev.experiencesByCoaches, pev.experiencesByCoaches, {small: true})}
        ${dualCard('Students at Experiences', ev.studentsAtExperiences, pev.studentsAtExperiences, {small: true})}
        ${dualCard('Weekday Event Attendances', ev.weekdayEventAttendances, pev.weekdayEventAttendances, {small: true})}
        ${dualCard('Weekday Event Attendees', ev.weekdayEventAttendees, pev.weekdayEventAttendees, {small: true})}
        ${dualCard('Shabbaton Attendances', ev.shabbatonAttendances, pev.shabbatonAttendances, {small: true})}
        ${dualCard('Shabbaton Attendees', ev.shabbatonAttendees, pev.shabbatonAttendees, {small: true})}
      </div>
    </section>

    <section class="kpi-section alltime">
      <h2 class="section-title">All Time Numbers</h2>
      <div class="kpi-grid-dual">
        ${dualCard('Students Registered for Souled', at.registeredForSouled, null)}
        ${dualCard('Students Who Met with a Coach', at.metWithCoach, null)}
        ${dualCard('Met with Coach 3+ Times', at.metWithCoach3Plus, null)}
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

    const isBoth = fy === 'both';
    buildCardsView(currentData, compareData, isBoth);
    buildTableView(currentData, compareData);
  } catch (err) {
    showError(err.message);
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

  // FY selector
  document.getElementById('fySelect').addEventListener('change', loadData);

  // Initial load
  loadData();
});
