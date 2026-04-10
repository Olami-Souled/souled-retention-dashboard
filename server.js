require('dotenv').config();
const express = require('express');
const jsforce = require('jsforce');
const path = require('path');
const fs = require('fs');

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

// Get FY string from dates
function getFYFromDates(fyDates) {
  const year = new Date(fyDates.end).getFullYear();
  return `FY${year - 2000}`;
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

// --- Executive data caching ---
const CACHE_DIR = path.join(__dirname, 'cache');
try { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }); }
catch (e) { console.error('Could not create cache dir:', e.message); }

function isFYComplete(fy) {
  const fyDates = getFYDates(fy);
  return new Date() > new Date(fyDates.end);
}

function getCachePath(fy) {
  return path.join(CACHE_DIR, `${fy}.json`);
}

function readCache(fy) {
  const cachePath = getCachePath(fy);
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  }
  return null;
}

function writeCache(fy, data) {
  try {
    fs.writeFileSync(getCachePath(fy), JSON.stringify(data, null, 2));
    console.log(`Cached ${fy} executive data to ${getCachePath(fy)}`);
  } catch (e) {
    console.error(`Could not write cache for ${fy}:`, e.message);
  }
}

// --- /api/executive-data ---
app.get('/api/executive-data', async (req, res) => {
  try {
    const fy = req.query.fy || 'FY26';
    const forceRefresh = req.query.refresh === 'true';

    // For completed FYs, serve from cache if available
    if (isFYComplete(fy) && !forceRefresh) {
      const cached = readCache(fy);
      if (cached) {
        console.log(`Serving ${fy} from cache`);
        return res.json(cached);
      }
    }

    // Fetch live from Salesforce
    console.log(`Fetching ${fy} live from Salesforce...`);
    const conn = await getSfConnection();
    const testIds = await getTestContactIds(conn);
    const fyDates = getFYDates(fy);

    const tpField = getTouchPointField(fy);
    const intField = getInteractionField(fy);

    // --- Section 1-3: Coaching & Buckets ---
    let coachingMetrics;
    if (tpField) {
      coachingMetrics = await computeCoachingFromRollup(conn, testIds, tpField, intField, fy, fyDates);
    } else {
      coachingMetrics = await computeCoachingFromTouchPoints(conn, testIds, intField, fyDates);
    }

    // --- Section 3: Interaction Buckets (separate query) ---
    const interactions = await computeInteractions(conn, testIds, intField, fy, fyDates);

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

    // Merge interactions into coaching result
    coachingMetrics.intStudents = interactions.intStudents;
    coachingMetrics.intBuckets = interactions.intBuckets;
    coachingMetrics.intContinuous = interactions.intContinuous;

    const result = {
      fy,
      fyDates,
      cachedAt: new Date().toISOString(),
      coaching: coachingMetrics,
      l2Trips,
      seminary,
      spiritualGrowth,
      graduation,
      events,
      allTime
    };

    // Cache completed FYs to disk
    if (isFYComplete(fy)) {
      writeCache(fy, result);
    }

    res.json(result);
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
  // Include Relationship to filter for Souled Coach only
  const records = await queryAll(conn,
    `SELECT Student__c, Relationship__r.Type__c FROM Touch_Point__c
     WHERE Touch_Point_Date__c >= ${fyDates.start} AND Touch_Point_Date__c <= ${fyDates.end}
     AND Test__c = false
     AND Relationship__r.Type__c = 'Souled Coach'`
  );

  // Count per student
  const studentCounts = new Map();
  for (const r of records) {
    if (testIds.has(r.Student__c)) continue;
    studentCounts.set(r.Student__c, (studentCounts.get(r.Student__c) || 0) + 1);
  }

  const totalStudents = studentCounts.size;
  let totalOneOnOnes = 0;
  for (const [, count] of studentCounts) totalOneOnOnes += count;

  // For buckets, need total touch points per student (all time)
  // Query in batches to avoid SOQL length limits
  const studentIds = Array.from(studentCounts.keys());
  const tpBuckets = { '1-3': 0, '4-6': 0, '7-9': 0, '10+': 0 };
  const intBuckets = { '1-3': 0, '4-6': 0, '7-9': 0, '10+': 0 };
  let intStudents = 0;

  const intFields = intField ? `, ${intField}` : ', Interactions_FY23__c, Interactions_FY24__c, Interactions_FY25__c';
  const batchSize = 500;
  for (let i = 0; i < studentIds.length; i += batchSize) {
    const batch = studentIds.slice(i, i + batchSize);
    const contacts = await queryAll(conn,
      `SELECT Id, Touch_Points__c, Interactions__c${intFields} FROM Contact WHERE Id IN ('${batch.join("','")}') AND Test_Old__c = false`
    );

    for (const c of contacts) {
      const totalTP = c.Touch_Points__c || 0;
      if (totalTP >= 10) tpBuckets['10+']++;
      else if (totalTP >= 7) tpBuckets['7-9']++;
      else if (totalTP >= 4) tpBuckets['4-6']++;
      else if (totalTP >= 1) tpBuckets['1-3']++;

      // Interactions
      const totalInt = c.Interactions__c || 0;
      let fyInt = 0;
      if (intField) {
        fyInt = c[intField] || 0;
      } else {
        fyInt = Math.max(0, totalInt - (c.Interactions_FY23__c || 0) - (c.Interactions_FY24__c || 0) - (c.Interactions_FY25__c || 0));
      }
      if (fyInt > 0) {
        intStudents++;
        if (totalInt >= 10) intBuckets['10+']++;
        else if (totalInt >= 7) intBuckets['7-9']++;
        else if (totalInt >= 4) intBuckets['4-6']++;
        else if (totalInt >= 1) intBuckets['1-3']++;
      }
    }
  }

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

async function computeInteractions(conn, testIds, intField, fy, fyDates) {
  // Query ALL contacts with interactions, not just those with touch points
  let query;
  if (intField) {
    // FY23/FY24/FY25: use the dedicated interaction field
    query = `SELECT Id, Interactions__c, ${intField} FROM Contact WHERE ${intField} > 0 AND Test_Old__c = false`;
  } else {
    // FY26: no dedicated field — derive from total minus older FYs
    query = `SELECT Id, Interactions__c, Interactions_FY23__c, Interactions_FY24__c, Interactions_FY25__c FROM Contact WHERE Interactions__c > 0 AND Test_Old__c = false`;
  }

  const records = await queryAll(conn, query);
  const intBuckets = { '1-3': 0, '4-6': 0, '7-9': 0, '10+': 0 };
  let intStudents = 0;

  for (const r of records) {
    if (testIds.has(r.Id)) continue;

    let fyInt = 0;
    if (intField) {
      fyInt = r[intField] || 0;
    } else {
      const total = r.Interactions__c || 0;
      const older = (r.Interactions_FY23__c || 0) + (r.Interactions_FY24__c || 0) + (r.Interactions_FY25__c || 0);
      fyInt = Math.max(0, total - older);
    }

    if (fyInt > 0) {
      intStudents++;
      // Bucket by TOTAL interactions (all time)
      const totalInt = r.Interactions__c || 0;
      if (totalInt >= 10) intBuckets['10+']++;
      else if (totalInt >= 7) intBuckets['7-9']++;
      else if (totalInt >= 4) intBuckets['4-6']++;
      else if (totalInt >= 1) intBuckets['1-3']++;
    }
  }

  return {
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
       AND Olami_Trip_Level__c = 2
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
    // Report includes many positive statuses (not just 'Attended')
    const positiveStatuses = [
      'Applied for Morasha Funding', 'Accepted', 'Applied for Scholarship',
      'Scholarship Approved', 'Registered', 'Paid',
      'Flight itinerary received from travel agent', 'Flight itinerary sent to student',
      'Flight itinerary confirmed', 'Booked Ticket', 'Attended',
      'Applied for Program', 'Accepted to Program', 'Recommended', 'Will_Apply_for_Program', 'Applied'
    ];
    const statusFilter = positiveStatuses.map(s => `'${s}'`).join(',');
    const records = await queryAll(conn,
      `SELECT Student__c FROM Olami_Activity_Engagement__c
       WHERE (Trip_Event_Type__c = 'Seminary' OR Trip_Event_Type__c = 'Sem Trip')
       AND Status__c IN (${statusFilter})
       AND Combined_start_date__c != null
       AND (End_Date_Combined__c >= ${fyDates.start} OR End_Date_Combined__c = null)
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
       AND Is_Registered_for_Souled__c > 0
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
    // Graduation tracked via Registration__c Stopped_Meeting_with_Coach_Reason__c
    // Report filters by touch points in current FY (not by date)
    // and Program__c = 'Souled'
    const graduationReasons = [
      'Connected with in-person learning',
      'Went to seminary',
      'Graduated to Orthodox conversion',
      'Graduated (became frum)'
    ];
    const reasonFilter = graduationReasons.map(r => `'${r}'`).join(',');

    // Determine the touch point field for this FY to filter for active students
    const tpField = getTouchPointField(getFYFromDates(fyDates));

    let tpFilter = '';
    if (tpField) {
      tpFilter = ` AND Student__r.${tpField} >= 1`;
    }

    const records = await queryAll(conn,
      `SELECT Id, Student__c, Stopped_Meeting_with_Coach_Reason__c FROM Registration__c
       WHERE RecordType.Name = 'Program'
       AND Program__r.Name = 'Souled'
       AND Stopped_Meeting_with_Coach_Reason__c IN (${reasonFilter})
       AND Student__r.Test_Old__c = false${tpFilter}`
    );

    let inPerson = 0, seminary = 0, conversion = 0;
    for (const r of records) {
      if (testIds.has(r.Student__c)) continue;
      const reason = r.Stopped_Meeting_with_Coach_Reason__c || '';
      if (reason === 'Connected with in-person learning') inPerson++;
      else if (reason === 'Went to seminary') seminary++;
      else if (reason === 'Graduated to Orthodox conversion') conversion++;
      else if (reason === 'Graduated (became frum)') inPerson++; // counts as in-person learning
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

  // Video and Zoom classes from Class_Attendance__c
  // Report filter logic: 1 AND 2 AND 3 AND (4 OR 5)
  // Duration >= 2 min (live) OR Watched_Recording >= 10% (recorded)
  try {
    const attendances = await queryAll(conn,
      `SELECT Student__c, Course_Occurrence_Type__c
       FROM Class_Attendance__c
       WHERE Student__r.Is_Registered_for_Souled__c = 1
       AND Student__r.Test_Old__c = false
       AND CreatedDate >= ${fyDates.start}T00:00:00Z
       AND CreatedDate <= ${fyDates.end}T23:59:59Z
       AND (Duration_in_Minutes__c >= 2 OR Watched_Recording__c >= 10)`
    );
    const videoStudents = new Set();
    const zoomStudents = new Set();
    let videoWatched = 0, zoomAttendances = 0;

    for (const r of attendances) {
      if (testIds.has(r.Student__c)) continue;
      if (r.Course_Occurrence_Type__c === 'On_Demand') {
        videoWatched++;
        videoStudents.add(r.Student__c);
      } else if (r.Course_Occurrence_Type__c === 'Live') {
        zoomAttendances++;
        zoomStudents.add(r.Student__c);
      }
    }
    result.videoClassesWatched = videoWatched;
    result.videoClassWatchers = videoStudents.size;
    result.liveZoomAttendances = zoomAttendances;
    result.liveZoomAttendees = zoomStudents.size;
  } catch (e) {
    console.error('Class attendance query error:', e.message);
  }

  // Coach-Led Courses (CLCs) from Contact_Coach_Course_Engagement__c
  try {
    const clcRecords = await queryAll(conn,
      `SELECT Coach_Course__c, Student_Name__c FROM Contact_Coach_Course_Engagement__c
       WHERE Started_Date__c >= ${fyDates.start}
       AND Started_Date__c <= ${fyDates.end}
       AND (Status__c = 'Completed' OR Status__c = 'Learning')`
    );
    result.coachLedCourses = clcRecords.length;
    result.clcStudents = new Set(clcRecords.map(r => r.Student_Name__c)).size;
  } catch (e) {
    console.error('CLC query error:', e.message);
  }

  // Experiences facilitated by coaches from Experience__c
  try {
    const experiences = await queryAll(conn,
      `SELECT Id FROM Experience__c
       WHERE RecordType.Name = 'Not Souled Event'
       AND Date__c >= ${fyDates.start}
       AND Date__c <= ${fyDates.end}`
    );
    result.experiencesByCoaches = experiences.length;
  } catch (e) {
    console.error('Experiences query error:', e.message);
  }

  // Students at experiences from Class_Attendance__c (Experience record type)
  try {
    const expAttendances = await queryAll(conn,
      `SELECT Student__c FROM Class_Attendance__c
       WHERE RecordType.Name = 'Experience'
       AND Student__r.Is_Registered_for_Souled__c = 1
       AND Student__r.Test_Old__c = false
       AND CreatedDate >= ${fyDates.start}T00:00:00Z
       AND CreatedDate <= ${fyDates.end}T23:59:59Z`
    );
    const expStudents = new Set();
    for (const r of expAttendances) {
      if (r.Student__c && !testIds.has(r.Student__c)) {
        expStudents.add(r.Student__c);
      }
    }
    result.studentsAtExperiences = expStudents.size;
  } catch (e) {
    console.error('Experience attendance query error:', e.message);
  }

  // Trip/Event Engagements (Weekday Events, Shabbatons)
  try {
    const engagements = await queryAll(conn,
      `SELECT Student__c, Trip_Event_Type__c
       FROM Olami_Activity_Engagement__c
       WHERE Status__c = 'Attended'
       AND Trip_Event_Start_Da__c >= ${fyDates.start}
       AND Trip_Event_Start_Da__c <= ${fyDates.end}`
    );

    const weekdayStudents = new Set();
    let weekdayCount = 0;
    const shabStudents = new Set();
    let shabCount = 0;

    for (const r of engagements) {
      if (testIds.has(r.Student__c)) continue;
      if (r.Trip_Event_Type__c === 'Weekday_Event') {
        weekdayCount++;
        weekdayStudents.add(r.Student__c);
      } else if (r.Trip_Event_Type__c === 'Shabbaton') {
        shabCount++;
        shabStudents.add(r.Student__c);
      }
    }

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
      `SELECT COUNT(Id) cnt FROM Contact
       WHERE Is_Registered_for_Souled__c > 0 AND Test_Old__c = false`
    );

    const metCoach = await queryAll(conn,
      `SELECT COUNT(Id) cnt FROM Contact
       WHERE Touch_Points__c > 0 AND Is_Registered_for_Souled__c > 0 AND Test_Old__c = false`
    );

    const metCoach3Plus = await queryAll(conn,
      `SELECT COUNT(Id) cnt FROM Contact
       WHERE Touch_Points__c >= 3 AND Is_Registered_for_Souled__c > 0 AND Test_Old__c = false`
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
