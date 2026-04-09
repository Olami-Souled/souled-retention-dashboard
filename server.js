require('dotenv').config();
const express = require('express');
const jsforce = require('jsforce');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// --- Salesforce connection ---
let sfConn = null;

async function getSfConnection() {
  if (sfConn && sfConn.accessToken) return sfConn;
  const conn = new jsforce.Connection({ loginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com' });
  await conn.login(process.env.SF_USERNAME, process.env.SF_PASSWORD + process.env.SF_SECURITY_TOKEN);
  sfConn = conn;
  console.log('Connected to Salesforce');
  return conn;
}

// --- Helpers ---

async function queryAll(conn, soql) {
  let result = await conn.query(soql);
  let records = result.records;
  while (!result.done) {
    result = await conn.queryMore(result.nextRecordsUrl);
    records = records.concat(result.records);
  }
  return records;
}

// Cache of test contact IDs (loaded once per server lifetime)
let testContactIds = null;

async function getTestContactIds(conn) {
  if (testContactIds) return testContactIds;
  const records = await queryAll(conn,
    `SELECT Id FROM Contact
     WHERE Test_Old__c = true
        OR FirstName LIKE '%test%'
        OR LastName LIKE '%test%'`
  );
  testContactIds = new Set(records.map(r => r.Id));
  console.log(`Loaded ${testContactIds.size} test contacts to exclude`);
  return testContactIds;
}

// --- /api/filters ---
app.get('/api/filters', async (req, res) => {
  try {
    const conn = await getSfConnection();

    const testIds = await getTestContactIds(conn);

    // Run sequentially to avoid jsforce queryMore concurrency issues
    const relationships = await queryAll(conn,
      `SELECT Mentor__c, Mentor__r.Name
       FROM Relationship__c
       WHERE Type__c = 'Souled Coach' AND Mentor__c != null`
    );
    const registrations = await queryAll(conn,
      `SELECT Referral_Type__c, Referral_Category__c,
              Referring_Organization__c, Referring_Organization__r.Name
       FROM Registration__c
       WHERE RecordType.Name = 'Program'`
    );

    // Dedupe coaches (exclude test coaches)
    const coachMap = new Map();
    for (const r of relationships) {
      if (r.Mentor__c && !coachMap.has(r.Mentor__c) && !testIds.has(r.Mentor__c)) {
        const name = (r.Mentor__r && r.Mentor__r.Name) || 'Unknown';
        coachMap.set(r.Mentor__c, name);
      }
    }
    const coaches = Array.from(coachMap, ([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Dedupe referral values
    const referralTypes = new Set();
    const referralCategories = new Set();
    const orgMap = new Map();

    for (const r of registrations) {
      if (r.Referral_Type__c) referralTypes.add(r.Referral_Type__c);
      if (r.Referral_Category__c) referralCategories.add(r.Referral_Category__c);
      if (r.Referring_Organization__c && !orgMap.has(r.Referring_Organization__c)) {
        orgMap.set(r.Referring_Organization__c, r.Referring_Organization__r?.Name || 'Unknown');
      }
    }

    const referringOrgs = Array.from(orgMap, ([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Find earliest relationship start date for default filter
    let earliestDate = null;
    for (const r of relationships) {
      if (r.Start_Date__c) {
        const d = new Date(r.Start_Date__c);
        if (!earliestDate || d < earliestDate) earliestDate = d;
      }
    }
    const earliestMonth = earliestDate
      ? `${earliestDate.getFullYear()}-${String(earliestDate.getMonth() + 1).padStart(2, '0')}`
      : null;

    // Cache for name lookups in breakdown endpoint
    filtersCache = { coaches, orgs: referringOrgs };

    res.json({
      coaches,
      referralTypes: Array.from(referralTypes).sort(),
      referralCategories: Array.from(referralCategories).sort(),
      referringOrgs,
      earliestMonth
    });
  } catch (err) {
    console.error('Error fetching filters:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- /api/cohort-data ---
app.get('/api/cohort-data', async (req, res) => {
  try {
    const conn = await getSfConnection();
    const testIds = await getTestContactIds(conn);
    const { startDate, endDate, referralType, referralCategory, referringOrg, hasReferringFriend, coachId, minMeetings, graduatedMode,
            referralTypeMode, referralCategoryMode, referringOrgMode, coachIdMode } = req.query;

    // 1. Query all Souled Coach relationships
    let relQuery = `SELECT Student__c, Mentor__c, Mentor__r.Name, Start_Date__c, End_Date__c
                    FROM Relationship__c
                    WHERE Type__c = 'Souled Coach' AND Start_Date__c != null`;
    // Only filter coach in SOQL for "is" mode; "is not" handled in JS
    if (coachId && coachIdMode !== 'not') relQuery += ` AND Mentor__c = '${coachId}'`;

    // 2. Query all Program registrations
    const regQuery = `SELECT Student__c, Referral_Type__c, Referral_Category__c,
                             Referring_Organization__c, Referring_Friend__c, Status__c,
                             Stopped_Meeting_with_Coach_Reason__c
                      FROM Registration__c
                      WHERE RecordType.Name = 'Program'`;

    // 3. Query contacts for touch points (meeting count)
    let contactQuery = `SELECT Id, Touch_Points__c FROM Contact WHERE Touch_Points__c != null`;
    if (minMeetings) contactQuery += ` AND Touch_Points__c >= ${parseInt(minMeetings, 10)}`;

    // Run sequentially to avoid jsforce queryMore concurrency issues
    const relationships = await queryAll(conn, relQuery);
    const registrations = await queryAll(conn, regQuery);
    const contacts = await queryAll(conn, contactQuery);

    // Build set of contacts that meet the minimum meetings threshold
    const contactMeetings = new Map();
    for (const c of contacts) {
      contactMeetings.set(c.Id, c.Touch_Points__c);
    }

    // 3. Build registration lookup by student (use first Program registration found)
    //    Also track which students have graduated
    const regByStudent = new Map();
    const graduatedStudents = new Set();
    for (const r of registrations) {
      if (!regByStudent.has(r.Student__c)) {
        regByStudent.set(r.Student__c, r);
      }
      if (r.Status__c === 'Graduated'
          || (r.Stopped_Meeting_with_Coach_Reason__c
              && r.Stopped_Meeting_with_Coach_Reason__c.includes('Graduated'))) {
        graduatedStudents.add(r.Student__c);
      }
    }

    // 4. Group relationships by student (exclude test students and test coaches)
    const studentMap = new Map(); // studentId -> { earliestStart, latestEnd, coaches }
    for (const r of relationships) {
      const sid = r.Student__c;
      if (testIds.has(sid) || testIds.has(r.Mentor__c)) continue;
      const start = r.Start_Date__c ? new Date(r.Start_Date__c) : null;
      const end = r.End_Date__c ? new Date(r.End_Date__c) : null;
      if (!start) continue;

      if (!studentMap.has(sid)) {
        studentMap.set(sid, {
          earliestStart: start,
          latestEnd: end, // null means still active
          coaches: new Set()
        });
      } else {
        const s = studentMap.get(sid);
        if (start < s.earliestStart) s.earliestStart = start;
        // latestEnd: null (still active) beats any date
        if (s.latestEnd !== null) {
          if (end === null) {
            s.latestEnd = null;
          } else if (end > s.latestEnd) {
            s.latestEnd = end;
          }
        }
      }
      if (r.Mentor__c) studentMap.get(sid).coaches.add(r.Mentor__c);
    }

    // 5. Build student list with referral data, apply filters
    // graduatedMode: "active" (default) = treat as always retained,
    //                "inactive" = use their actual end date,
    //                "exclude" = remove from report
    const gradMode = graduatedMode || 'active';

    const students = [];
    for (const [studentId, data] of studentMap) {
      const reg = regByStudent.get(studentId);
      const isGraduated = graduatedStudents.has(studentId);

      // Apply graduated filter
      if (isGraduated && gradMode === 'exclude') continue;

      // Apply minimum meetings filter
      if (minMeetings && !contactMeetings.has(studentId)) continue;

      // Apply referral filters (support "is" and "is not" modes)
      if (referralType) {
        if (referralTypeMode === 'not') {
          if (reg && reg.Referral_Type__c === referralType) continue;
        } else {
          if (!reg || reg.Referral_Type__c !== referralType) continue;
        }
      }
      if (referralCategory) {
        if (referralCategoryMode === 'not') {
          if (reg && reg.Referral_Category__c === referralCategory) continue;
        } else {
          if (!reg || reg.Referral_Category__c !== referralCategory) continue;
        }
      }
      if (referringOrg) {
        if (referringOrgMode === 'not') {
          if (reg && reg.Referring_Organization__c === referringOrg) continue;
        } else {
          if (!reg || reg.Referring_Organization__c !== referringOrg) continue;
        }
      }
      if (hasReferringFriend === 'true' && (!reg || !reg.Referring_Friend__c)) continue;

      // Apply coach filter for "is not" mode (student must not have this coach in any relationship)
      if (coachId && coachIdMode === 'not') {
        if (data.coaches.has(coachId)) continue;
      }

      // Apply date range filter on cohort start
      const cohortStart = data.earliestStart;
      if (startDate && cohortStart < new Date(startDate)) continue;
      if (endDate && cohortStart > new Date(endDate)) continue;

      // If graduated and mode is "active", treat as still retained (null end date)
      const latestEnd = (isGraduated && gradMode === 'active') ? null : data.latestEnd;

      students.push({
        studentId,
        cohortStart,
        latestEnd
      });
    }

    // 6. Group into monthly cohorts and compute retention
    const cohortMap = new Map(); // "YYYY-MM" -> { students: [...] }
    for (const s of students) {
      const key = `${s.cohortStart.getFullYear()}-${String(s.cohortStart.getMonth() + 1).padStart(2, '0')}`;
      if (!cohortMap.has(key)) cohortMap.set(key, []);
      cohortMap.get(key).push(s);
    }

    // Determine max periods (from earliest cohort to today)
    const today = new Date();
    const sortedMonths = Array.from(cohortMap.keys()).sort();
    let maxPeriods = 0;
    if (sortedMonths.length > 0) {
      const earliest = new Date(sortedMonths[0] + '-01');
      maxPeriods = Math.ceil((today - earliest) / (30 * 24 * 60 * 60 * 1000));
      maxPeriods = Math.min(maxPeriods, 48); // cap at 48 periods (4 years)
    }

    const cohorts = sortedMonths.map(month => {
      const studentsInCohort = cohortMap.get(month);
      const total = studentsInCohort.length;
      const cohortStartDate = new Date(month + '-01');

      // How many periods are possible for this cohort
      const possiblePeriods = Math.min(
        Math.floor((today - cohortStartDate) / (30 * 24 * 60 * 60 * 1000)),
        maxPeriods
      );

      const periods = [];
      for (let p = 0; p < possiblePeriods; p++) {
        const periodEnd = new Date(cohortStartDate);
        periodEnd.setDate(periodEnd.getDate() + (p + 1) * 30);

        // Only show period if it's in the past
        if (periodEnd > today) break;

        let retained = 0;
        for (const s of studentsInCohort) {
          // Retained if latestEnd is null (still active) or latestEnd > periodEnd
          if (s.latestEnd === null || s.latestEnd > periodEnd) {
            retained++;
          }
        }
        periods.push({
          period: p + 1,
          retained,
          pct: total > 0 ? Math.round((retained / total) * 1000) / 10 : 0
        });
      }

      return { month, total, periods };
    });

    res.json({ cohorts, maxPeriods, totalStudents: students.length });
  } catch (err) {
    console.error('Error fetching cohort data:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- /api/breakdown-data ---
app.get('/api/breakdown-data', async (req, res) => {
  try {
    const conn = await getSfConnection();
    const testIds = await getTestContactIds(conn);
    const { startDate, endDate, minMeetings, graduatedMode, breakdownBy, selectedIds } = req.query;

    if (!breakdownBy || !selectedIds) {
      return res.json({ series: [] });
    }

    const ids = selectedIds.split(',');

    // Query all data (no coach/referral filters — we split by breakdown dimension)
    const relationships = await queryAll(conn,
      `SELECT Student__c, Mentor__c, Mentor__r.Name, Start_Date__c, End_Date__c
       FROM Relationship__c
       WHERE Type__c = 'Souled Coach' AND Start_Date__c != null`
    );
    const registrations = await queryAll(conn,
      `SELECT Student__c, Referral_Type__c, Referral_Category__c,
              Referring_Organization__c, Referring_Organization__r.Name,
              Referring_Friend__c, Status__c, Stopped_Meeting_with_Coach_Reason__c
       FROM Registration__c
       WHERE RecordType.Name = 'Program'`
    );

    let contacts = null;
    if (minMeetings) {
      const contactRecords = await queryAll(conn,
        `SELECT Id, Touch_Points__c FROM Contact WHERE Touch_Points__c >= ${parseInt(minMeetings, 10)}`
      );
      contacts = new Set(contactRecords.map(c => c.Id));
    }

    // Build registration lookup + graduated set
    const regByStudent = new Map();
    const graduatedStudents = new Set();
    for (const r of registrations) {
      if (!regByStudent.has(r.Student__c)) regByStudent.set(r.Student__c, r);
      if (r.Status__c === 'Graduated'
          || (r.Stopped_Meeting_with_Coach_Reason__c
              && r.Stopped_Meeting_with_Coach_Reason__c.includes('Graduated'))) {
        graduatedStudents.add(r.Student__c);
      }
    }

    const gradMode = graduatedMode || 'active';

    // Group relationships by student
    const studentMap = new Map();
    // Also track per-student: which coaches and which referring org
    for (const r of relationships) {
      const sid = r.Student__c;
      if (testIds.has(sid) || testIds.has(r.Mentor__c)) continue;
      const start = r.Start_Date__c ? new Date(r.Start_Date__c) : null;
      const end = r.End_Date__c ? new Date(r.End_Date__c) : null;
      if (!start) continue;

      if (!studentMap.has(sid)) {
        studentMap.set(sid, { earliestStart: start, latestEnd: end, coaches: new Set() });
      } else {
        const s = studentMap.get(sid);
        if (start < s.earliestStart) s.earliestStart = start;
        if (s.latestEnd !== null) {
          if (end === null) s.latestEnd = null;
          else if (end > s.latestEnd) s.latestEnd = end;
        }
      }
      if (r.Mentor__c) studentMap.get(sid).coaches.add(r.Mentor__c);
    }

    // Build filtered student list
    const students = [];
    for (const [studentId, data] of studentMap) {
      const isGraduated = graduatedStudents.has(studentId);
      if (isGraduated && gradMode === 'exclude') continue;
      if (minMeetings && contacts && !contacts.has(studentId)) continue;

      const cohortStart = data.earliestStart;
      if (startDate && cohortStart < new Date(startDate)) continue;
      if (endDate && cohortStart > new Date(endDate)) continue;

      const latestEnd = (isGraduated && gradMode === 'active') ? null : data.latestEnd;
      const reg = regByStudent.get(studentId);

      students.push({ studentId, cohortStart, latestEnd, coaches: data.coaches, reg });
    }

    // For each selected ID, compute average retention curve
    const today = new Date();
    const series = [];

    for (const id of ids) {
      // Filter students belonging to this breakdown value
      const subset = students.filter(s => {
        if (breakdownBy === 'coach') return s.coaches.has(id);
        if (breakdownBy === 'org') return s.reg && s.reg.Referring_Organization__c === id;
        if (breakdownBy === 'referralType') return s.reg && s.reg.Referral_Type__c === id;
        if (breakdownBy === 'referralCategory') return s.reg && s.reg.Referral_Category__c === id;
        return false;
      });

      if (subset.length === 0) continue;

      // Group into monthly cohorts
      const cohortMap = new Map();
      for (const s of subset) {
        const key = `${s.cohortStart.getFullYear()}-${String(s.cohortStart.getMonth() + 1).padStart(2, '0')}`;
        if (!cohortMap.has(key)) cohortMap.set(key, []);
        cohortMap.get(key).push(s);
      }

      const sortedMonths = Array.from(cohortMap.keys()).sort();
      let maxPeriods = 0;
      if (sortedMonths.length > 0) {
        const earliest = new Date(sortedMonths[0] + '-01');
        maxPeriods = Math.ceil((today - earliest) / (30 * 24 * 60 * 60 * 1000));
        maxPeriods = Math.min(maxPeriods, 48);
      }

      // Compute average retention per period
      const periodSums = new Array(maxPeriods).fill(0);
      const periodCounts = new Array(maxPeriods).fill(0);

      for (const month of sortedMonths) {
        const studentsInCohort = cohortMap.get(month);
        const total = studentsInCohort.length;
        const cohortStartDate = new Date(month + '-01');

        for (let p = 0; p < maxPeriods; p++) {
          const periodEnd = new Date(cohortStartDate);
          periodEnd.setDate(periodEnd.getDate() + (p + 1) * 30);
          if (periodEnd > today) break;

          let retained = 0;
          for (const s of studentsInCohort) {
            if (s.latestEnd === null || s.latestEnd > periodEnd) retained++;
          }
          const pct = total > 0 ? Math.round((retained / total) * 1000) / 10 : 0;
          periodSums[p] += pct;
          periodCounts[p]++;
        }
      }

      const averages = [];
      for (let p = 0; p < maxPeriods; p++) {
        if (periodCounts[p] > 0) {
          averages.push(Math.round((periodSums[p] / periodCounts[p]) * 10) / 10);
        }
      }

      // Look up name
      let name = id;
      if (breakdownBy === 'coach') {
        const coach = filtersCache?.coaches?.find(c => c.id === id);
        if (coach) name = coach.name;
      } else if (breakdownBy === 'org') {
        const org = filtersCache?.orgs?.find(o => o.id === id);
        if (org) name = org.name;
      }
      // referralType and referralCategory use the value as the name already

      series.push({ id, name, studentCount: subset.length, averages });
    }

    res.json({ series });
  } catch (err) {
    console.error('Error fetching breakdown data:', err);
    res.status(500).json({ error: err.message });
  }
});

// Simple cache for name lookups in breakdown endpoint
let filtersCache = null;

// --- Executive Report helpers ---

// FY date boundaries (Sep 1 - Aug 31)
function getFYDates(fy) {
  // fy = "FY26" means Sep 1 2025 - Aug 31 2026
  const year = parseInt(fy.replace('FY', ''), 10) + 2000;
  return {
    start: `${year - 1}-09-01`,
    end: `${year}-08-31`
  };
}

// Map FY to the Contact rollup field names
// NOTE: Touch_Points_FY25__c is labeled "FY26" (repurposed)
function getTouchPointField(fy) {
  const map = { FY23: 'Touch_Points_FY23x__c', FY24: 'Touch_Points_FY24__c', FY26: 'Touch_Points_FY25__c' };
  return map[fy] || null; // FY25 has no rollup field
}
function getInteractionField(fy) {
  const map = { FY23: 'Interactions_FY23__c', FY24: 'Interactions_FY24__c', FY25: 'Interactions_FY25__c' };
  return map[fy] || null; // FY26 has no rollup field
}

// --- /api/executive-data ---
app.get('/api/executive-data', async (req, res) => {
  try {
    const conn = await getSfConnection();
    const testIds = await getTestContactIds(conn);
    const fy = req.query.fy || 'FY26';
    const fyDates = getFYDates(fy);

    const tpField = getTouchPointField(fy);
    const intField = getInteractionField(fy);

    // --- Section 1-3: Coaching & Buckets ---
    // We need Touch Points and Interactions per student for the selected FY
    let coachingMetrics;
    if (tpField) {
      // Use rollup field
      coachingMetrics = await computeCoachingFromRollup(conn, testIds, tpField, intField, fy, fyDates);
    } else {
      // FY25: query Touch_Point__c directly
      coachingMetrics = await computeCoachingFromTouchPoints(conn, testIds, intField, fyDates);
    }

    // --- Section 4: L2 Trips ---
    const l2Trips = await computeL2Trips(conn, testIds, fyDates);

    // --- Section 5-6: SO/STAM and Step Forward ---
    const spiritualGrowth = await computeSpiritualGrowth(conn, testIds, fyDates);

    // --- Section 7: Graduation ---
    const graduation = await computeGraduation(conn, testIds, fyDates);

    // --- Section 8: Classes & Events ---
    const events = await computeClassesAndEvents(conn, testIds, fyDates);

    // --- Section 9: All-time ---
    const allTime = await computeAllTime(conn, testIds);

    // --- Section 4b: Seminary ---
    const seminary = await computeSeminary(conn, testIds, fyDates);

    res.json({
      fy,
      fyDates,
      coaching: coachingMetrics,
      l2Trips,
      seminary,
      spiritualGrowth,
      graduation,
      events,
      allTime
    });
  } catch (err) {
    console.error('Error fetching executive data:', err);
    res.status(500).json({ error: err.message });
  }
});

async function computeCoachingFromRollup(conn, testIds, tpField, intField, fy, fyDates) {
  // Query contacts with touch points in the selected FY
  const fields = `Id, Touch_Points__c, ${tpField}`;
  const intFieldStr = intField ? `, ${intField}` : ', Interactions_FY23__c, Interactions_FY24__c, Interactions_FY25__c';
  const intTotalStr = ', Interactions__c';

  const records = await queryAll(conn,
    `SELECT ${fields}${intFieldStr}${intTotalStr} FROM Contact WHERE ${tpField} > 0 AND Test_Old__c = false`
  );

  // Filter out test contacts
  const students = records.filter(r => !testIds.has(r.Id));

  const totalStudents = students.length;
  let totalOneOnOnes = 0;
  const tpBuckets = { '1-3': 0, '4-6': 0, '7-9': 0, '10+': 0 };
  const intBuckets = { '1-3': 0, '4-6': 0, '7-9': 0, '10+': 0 };

  for (const s of students) {
    const tp = s[tpField] || 0;
    totalOneOnOnes += tp;

    // Bucket by TOTAL touch points (all time), not just this FY
    const totalTP = s.Touch_Points__c || 0;
    if (totalTP >= 10) tpBuckets['10+']++;
    else if (totalTP >= 7) tpBuckets['7-9']++;
    else if (totalTP >= 4) tpBuckets['4-6']++;
    else if (totalTP >= 1) tpBuckets['1-3']++;

    // Interaction buckets — for FY26, derive from total minus older FYs
    const totalInt = s.Interactions__c || 0;
    let fyInt = 0;
    if (intField) {
      fyInt = s[intField] || 0;
    } else {
      // FY26: no dedicated field, derive from total - FY23 - FY24 - FY25
      const i23 = s.Interactions_FY23__c || 0;
      const i24 = s.Interactions_FY24__c || 0;
      const i25 = s.Interactions_FY25__c || 0;
      fyInt = Math.max(0, totalInt - i23 - i24 - i25);
    }
    if (fyInt > 0) {
      if (totalInt >= 10) intBuckets['10+']++;
      else if (totalInt >= 7) intBuckets['7-9']++;
      else if (totalInt >= 4) intBuckets['4-6']++;
      else if (totalInt >= 1) intBuckets['1-3']++;
    }
  }

  // Interaction totals
  let intStudents = 0;
  for (const s of students) {
    let fyInt = 0;
    if (intField) {
      fyInt = s[intField] || 0;
    } else {
      const total = s.Interactions__c || 0;
      const i23 = s.Interactions_FY23__c || 0;
      const i24 = s.Interactions_FY24__c || 0;
      const i25 = s.Interactions_FY25__c || 0;
      fyInt = Math.max(0, total - i23 - i24 - i25);
    }
    if (fyInt > 0) intStudents++;
  }

  // Average weekly one on ones
  const fyStart = new Date(fyDates.start);
  const now = new Date();
  const fyEnd = new Date(fyDates.end);
  const effectiveEnd = now < fyEnd ? now : fyEnd;
  const weeksElapsed = Math.max(1, Math.round((effectiveEnd - fyStart) / (7 * 24 * 60 * 60 * 1000)));
  const avgWeekly = Math.round(totalOneOnOnes / weeksElapsed);

  return {
    studentsMetCoach: totalStudents,
    totalOneOnOnes,
    avgWeeklyOneOnOnes: avgWeekly,
    tpBuckets,
    tpContinuous: tpBuckets['7-9'] + tpBuckets['10+'],
    intStudents,
    intBuckets,
    intContinuous: intBuckets['7-9'] + intBuckets['10+']
  };
}

async function computeCoachingFromTouchPoints(conn, testIds, intField, fyDates) {
  // For FY25 (no rollup field), query Touch_Point__c directly
  const records = await queryAll(conn,
    `SELECT Student__c FROM Touch_Point__c
     WHERE Touch_Point_Date__c >= ${fyDates.start} AND Touch_Point_Date__c <= ${fyDates.end}
     AND Test__c = false`
  );

  // Count per student
  const studentCounts = new Map();
  for (const r of records) {
    if (testIds.has(r.Student__c)) continue;
    studentCounts.set(r.Student__c, (studentCounts.get(r.Student__c) || 0) + 1);
  }

  const totalStudents = studentCounts.size;
  const totalOneOnOnes = records.filter(r => !testIds.has(r.Student__c)).length;

  // For buckets, need total touch points per student (all time)
  const studentIds = Array.from(studentCounts.keys());
  const tpBuckets = { '1-3': 0, '4-6': 0, '7-9': 0, '10+': 0 };

  if (studentIds.length > 0) {
    // Query total touch points for these students
    const contacts = await queryAll(conn,
      `SELECT Id, Touch_Points__c, Interactions__c${intField ? ', ' + intField : ''} FROM Contact WHERE Id IN ('${studentIds.slice(0, 200).join("','")}') AND Test_Old__c = false`
    );

    const contactMap = new Map();
    for (const c of contacts) contactMap.set(c.Id, c);

    for (const [sid] of studentCounts) {
      const c = contactMap.get(sid);
      if (!c) continue;
      const totalTP = c.Touch_Points__c || 0;
      if (totalTP >= 10) tpBuckets['10+']++;
      else if (totalTP >= 7) tpBuckets['7-9']++;
      else if (totalTP >= 4) tpBuckets['4-6']++;
      else if (totalTP >= 1) tpBuckets['1-3']++;
    }
  }

  // Interaction data from formula fields
  const intBuckets = { '1-3': 0, '4-6': 0, '7-9': 0, '10+': 0 };
  let intStudents = 0;

  const fyStart = new Date(fyDates.start);
  const now = new Date();
  const fyEnd = new Date(fyDates.end);
  const effectiveEnd = now < fyEnd ? now : fyEnd;
  const weeksElapsed = Math.max(1, Math.round((effectiveEnd - fyStart) / (7 * 24 * 60 * 60 * 1000)));
  const avgWeekly = Math.round(totalOneOnOnes / weeksElapsed);

  return {
    studentsMetCoach: totalStudents,
    totalOneOnOnes,
    avgWeeklyOneOnOnes: avgWeekly,
    tpBuckets,
    tpContinuous: tpBuckets['7-9'] + tpBuckets['10+'],
    intStudents,
    intBuckets,
    intContinuous: intBuckets['7-9'] + intBuckets['10+']
  };
}

async function computeL2Trips(conn, testIds, fyDates) {
  try {
    const records = await queryAll(conn,
      `SELECT Student__c FROM Olami_Activity_Engagement__c
       WHERE Status__c = 'Attended'
       AND Trip_Event_Start_Da__c >= ${fyDates.start}
       AND Trip_Event_Start_Da__c <= ${fyDates.end}`
    );
    const uniqueStudents = new Set(records.map(r => r.Student__c).filter(id => !testIds.has(id)));
    return { participants: uniqueStudents.size };
  } catch (e) {
    console.error('L2 trips query error:', e.message);
    return { participants: null };
  }
}

async function computeSeminary(conn, testIds, fyDates) {
  try {
    // Seminary placements tracked via Olami_Activity_Engagement__c
    // with Trip_Event_Type__c containing 'Seminary' or 'Sem Trip'
    const records = await queryAll(conn,
      `SELECT Student__c FROM Olami_Activity_Engagement__c
       WHERE (Trip_Event_Type__c = 'Seminary' OR Trip_Event_Type__c = 'Sem Trip')
       AND Status__c = 'Attended'
       AND Trip_Event_Start_Da__c >= ${fyDates.start}
       AND Trip_Event_Start_Da__c <= ${fyDates.end}
       AND Student__r.Test_Old__c = false`
    );
    const uniqueStudents = new Set(records.map(r => r.Student__c).filter(id => !testIds.has(id)));
    return { placements: uniqueStudents.size };
  } catch (e) {
    console.error('Seminary query error:', e.message);
    return { placements: null };
  }
}

async function computeSpiritualGrowth(conn, testIds, fyDates) {
  // SO/STAM use FY picklist fields (e.g., FY_Became_SO__c = 'FY26')
  // Derive the FY label from the date range
  const fyYear = new Date(fyDates.end).getFullYear();
  const fyLabel = String(fyYear); // Picklist uses "2026" for FY26

  try {
    // Query all spiritual growth in one go
    const records = await queryAll(conn,
      `SELECT Id, FY_Became_SO__c, FY_Became_STAM__c,
              FY_Became_Shomer_Kashrus__c, FY_Became_Shomer_Tznius__c,
              FY_Became__c
       FROM Contact
       WHERE Test_Old__c = false
       AND (FY_Became_SO__c = '${fyLabel}'
            OR FY_Became_STAM__c = '${fyLabel}'
            OR FY_Became_Shomer_Kashrus__c = '${fyLabel}'
            OR FY_Became_Shomer_Tznius__c = '${fyLabel}'
            OR FY_Became__c = '${fyLabel}')`
    );

    let so = 0, stam = 0, kashrus = 0, tznius = 0, marryJewish = 0;
    const soOrStamIds = new Set();

    for (const r of records) {
      if (testIds.has(r.Id)) continue;
      if (r.FY_Became_SO__c === fyLabel) { so++; soOrStamIds.add(r.Id); }
      if (r.FY_Became_STAM__c === fyLabel) { stam++; soOrStamIds.add(r.Id); }
      if (r.FY_Became_Shomer_Kashrus__c === fyLabel) kashrus++;
      if (r.FY_Became_Shomer_Tznius__c === fyLabel) tznius++;
      if (r.FY_Became__c === fyLabel) marryJewish++;
    }

    return { so, stam, uniqueSOSTAM: soOrStamIds.size, kashrus, tznius, marryJewish };
  } catch (e) {
    console.error('Spiritual growth query error:', e.message);
    return { so: null, stam: null, uniqueSOSTAM: null, kashrus: null, tznius: null, marryJewish: null };
  }
}

async function computeGraduation(conn, testIds, fyDates) {
  try {
    // Graduation tracked via Registration__c status or Stopped_Meeting_with_Coach_Reason__c
    const records = await queryAll(conn,
      `SELECT Id, Stopped_Meeting_with_Coach_Reason__c FROM Registration__c
       WHERE RecordType.Name = 'Program'
       AND (Status__c = 'Graduated' OR Stopped_Meeting_with_Coach_Reason__c LIKE '%Graduated%')
       AND LastModifiedDate >= ${fyDates.start}T00:00:00Z
       AND LastModifiedDate <= ${fyDates.end}T23:59:59Z
       AND Student__r.Test_Old__c = false`
    );

    let inPerson = 0, seminary = 0, conversion = 0;
    for (const r of records) {
      const reason = r.Stopped_Meeting_with_Coach_Reason__c || '';
      if (reason.includes('In Person') || reason.includes('in person')) inPerson++;
      else if (reason.includes('Seminary') || reason.includes('seminary')) seminary++;
      else if (reason.includes('Conversion') || reason.includes('conversion')) conversion++;
      else inPerson++; // default
    }

    return { inPersonLearning: inPerson, longTermSeminary: seminary, orthodoxConversion: conversion };
  } catch (e) {
    console.error('Graduation query error:', e.message);
    return { inPersonLearning: null, longTermSeminary: null, orthodoxConversion: null };
  }
}

async function computeClassesAndEvents(conn, testIds, fyDates) {
  const result = {
    videoClassesWatched: 0, videoClassWatchers: 0,
    liveZoomAttendances: 0, liveZoomAttendees: 0,
    coachLedCourses: 0, clcStudents: 0,
    experiencesByCoaches: 0, studentsAtExperiences: 0,
    weekdayEventAttendances: 0, weekdayEventAttendees: 0,
    shabbatonAttendances: 0, shabbatonAttendees: 0
  };

  // Video and Zoom classes from Registration__c (Course Occurrence)
  try {
    const courseRegs = await queryAll(conn,
      `SELECT Student__c, Record_type_of_course_occurence__c, Completed_Classes__c
       FROM Registration__c
       WHERE RecordType.Name = 'Course Occurrence'
       AND CreatedDate >= ${fyDates.start}T00:00:00Z
       AND CreatedDate <= ${fyDates.end}T23:59:59Z
       AND Student__r.Test_Old__c = false`
    );
    const videoStudents = new Set();
    const zoomStudents = new Set();
    let videoWatched = 0, zoomAttendances = 0;

    for (const r of courseRegs) {
      if (testIds.has(r.Student__c)) continue;
      const completed = r.Completed_Classes__c || 0;
      if (r.Record_type_of_course_occurence__c === 'On Demand') {
        videoWatched += completed;
        if (completed > 0) videoStudents.add(r.Student__c);
      } else if (r.Record_type_of_course_occurence__c === 'Live') {
        zoomAttendances += completed;
        if (completed > 0) zoomStudents.add(r.Student__c);
      }
    }
    result.videoClassesWatched = videoWatched;
    result.videoClassWatchers = videoStudents.size;
    result.liveZoomAttendances = zoomAttendances;
    result.liveZoomAttendees = zoomStudents.size;
  } catch (e) {
    console.error('Course occurrence query error:', e.message);
  }

  // Coach-Led Courses (CLCs) from Contact_Coach_Course_Engagement__c
  try {
    const clcRecords = await queryAll(conn,
      `SELECT Coach_Course__c, Student_Name__c FROM Contact_Coach_Course_Engagement__c
       WHERE Started_Date__c >= ${fyDates.start}
       AND Started_Date__c <= ${fyDates.end}`
    );
    result.coachLedCourses = new Set(clcRecords.map(r => r.Coach_Course__c)).size;
    result.clcStudents = clcRecords.length;
  } catch (e) {
    console.error('CLC query error:', e.message);
  }

  // Trip/Event Engagements (Weekday Events, Shabbatons)
  try {
    const engagements = await queryAll(conn,
      `SELECT Student__c, Emersive_Learning_Experience__c, Trip_Event_Type__c
       FROM Olami_Activity_Engagement__c
       WHERE Status__c = 'Attended'
       AND Trip_Event_Start_Da__c >= ${fyDates.start}
       AND Trip_Event_Start_Da__c <= ${fyDates.end}`
    );
    const filtered = engagements.filter(r => !testIds.has(r.Student__c));

    const expEvents = new Set();
    const expStudents = new Set();
    const weekdayStudents = new Set();
    let weekdayCount = 0;
    const shabStudents = new Set();
    let shabCount = 0;

    for (const r of filtered) {
      expEvents.add(r.Emersive_Learning_Experience__c);
      expStudents.add(r.Student__c);
      if (r.Trip_Event_Type__c === 'Weekday_Event') {
        weekdayCount++;
        weekdayStudents.add(r.Student__c);
      } else if (r.Trip_Event_Type__c === 'Shabbaton') {
        shabCount++;
        shabStudents.add(r.Student__c);
      }
    }

    result.experiencesByCoaches = expEvents.size;
    result.studentsAtExperiences = expStudents.size;
    result.weekdayEventAttendances = weekdayCount;
    result.weekdayEventAttendees = weekdayStudents.size;
    result.shabbatonAttendances = shabCount;
    result.shabbatonAttendees = shabStudents.size;
  } catch (e) {
    console.error('Events query error:', e.message);
  }

  return result;
}

async function computeAllTime(conn, testIds) {
  try {
    const regCount = await queryAll(conn,
      `SELECT COUNT(Id) cnt FROM Registration__c
       WHERE RecordType.Name = 'Program' AND Student__r.Test_Old__c = false`
    );

    const metCoach = await queryAll(conn,
      `SELECT COUNT(Id) cnt FROM Contact
       WHERE Touch_Points__c > 0 AND Test_Old__c = false`
    );

    const metCoach3Plus = await queryAll(conn,
      `SELECT COUNT(Id) cnt FROM Contact
       WHERE Touch_Points__c >= 3 AND Test_Old__c = false`
    );

    return {
      registeredForSouled: regCount[0]?.cnt || 0,
      metWithCoach: metCoach[0]?.cnt || 0,
      metWithCoach3Plus: metCoach3Plus[0]?.cnt || 0
    };
  } catch (e) {
    console.error('All-time query error:', e.message);
    return { registeredForSouled: null, metWithCoach: null, metWithCoach3Plus: null };
  }
}

app.listen(PORT, () => {
  console.log(`Retention dashboard running at http://localhost:${PORT}`);
});
