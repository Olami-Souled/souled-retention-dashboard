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

app.listen(PORT, () => {
  console.log(`Retention dashboard running at http://localhost:${PORT}`);
});
