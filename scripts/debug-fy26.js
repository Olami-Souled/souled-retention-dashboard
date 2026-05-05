// Standalone repro for the FY26 500 — runs each /api/executive-data SOQL query
// directly using the SF CLI's stored access token, so we don't need to set up
// the OAuth refresh-token env vars locally.
//
// Run: cd .. && node scripts/debug-fy26.js
//
// Throws nothing — prints PASS / FAIL per stage.

const { execSync } = require('child_process');
const jsforce = require('jsforce');

function getSfAuthFromCli(alias = process.env.SF_ALIAS || 'claude-api') {
  const out = execSync(`sf org display -o ${alias} --json`, { encoding: 'utf8' });
  const j = JSON.parse(out);
  return { accessToken: j.result.accessToken, instanceUrl: j.result.instanceUrl };
}

function getFYDates(fy) {
  const year = parseInt(fy.replace('FY', ''), 10) + 2000;
  return { start: `${year - 1}-09-01`, end: `${year}-08-31` };
}

function getTouchPointField(fy) {
  const map = { FY23: 'Touch_Points_FY23x__c', FY24: 'Touch_Points_FY24__c', FY26: 'Touch_Points_FY25__c' };
  return map[fy] || null;
}

function getInteractionField(fy) {
  const map = { FY23: 'Interactions_FY23__c', FY24: 'Interactions_FY24__c', FY26: 'Interactions_FY25__c' };
  return map[fy] || null;
}

async function queryAll(conn, soql) {
  let result = await conn.query(soql);
  let records = result.records;
  while (!result.done) {
    result = await conn.queryMore(result.nextRecordsUrl);
    records = records.concat(result.records);
  }
  return records;
}

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    console.log(`  PASS  ${label}  (${Date.now() - t0}ms)  ${out}`);
  } catch (e) {
    console.log(`  FAIL  ${label}  (${Date.now() - t0}ms)`);
    console.log(`        ${e.message}`);
    if (e.errorCode) console.log(`        errorCode=${e.errorCode}`);
  }
}

async function main() {
  const fy = process.argv[2] || 'FY26';
  console.log(`Reproducing /api/executive-data?fy=${fy}\n`);

  const { accessToken, instanceUrl } = getSfAuthFromCli();
  const conn = new jsforce.Connection({ accessToken, instanceUrl });

  const fyDates = getFYDates(fy);
  const tpField = getTouchPointField(fy);
  const intField = getInteractionField(fy);
  console.log(`tpField=${tpField}  intField=${intField}  start=${fyDates.start}  end=${fyDates.end}\n`);

  await timed('getTestContactIds', async () => {
    const r = await queryAll(conn, `SELECT Id FROM Contact WHERE Test_Old__c = true OR FirstName LIKE '%test%' OR LastName LIKE '%test%'`);
    return `${r.length} test contacts`;
  });

  await timed('computeCoachingFromRollup main query', async () => {
    const fields = `Id, Touch_Points__c, ${tpField}`;
    const intFieldStr = intField ? `, ${intField}` : ', Interactions_FY23__c, Interactions_FY24__c, Interactions_FY25__c';
    const intTotalStr = ', Interactions__c';
    const r = await queryAll(conn, `SELECT ${fields}${intFieldStr}${intTotalStr} FROM Contact WHERE ${tpField} > 0 AND Test_Old__c = false`);
    return `${r.length} contacts`;
  });

  await timed('computeInteractions main query', async () => {
    const r = await queryAll(conn, `SELECT Id, Interactions__c, ${intField} FROM Contact WHERE ${intField} > 0 AND Test_Old__c = false`);
    return `${r.length} contacts`;
  });

  await timed('computeL2Trips', async () => {
    const r = await queryAll(conn, `SELECT Student__c FROM Olami_Activity_Engagement__c WHERE Status__c = 'Attended' AND Olami_Trip_Level__c = 2 AND Trip_Event_Start_Da__c >= ${fyDates.start} AND Trip_Event_Start_Da__c <= ${fyDates.end}`);
    return `${r.length} engagements`;
  });

  await timed('computeSeminary', async () => {
    const positiveStatuses = ['Applied for Morasha Funding','Accepted','Applied for Scholarship','Scholarship Approved','Registered','Paid','Flight itinerary received from travel agent','Flight itinerary sent to student','Flight itinerary confirmed','Booked Ticket','Attended','Applied for Program','Accepted to Program','Recommended','Will_Apply_for_Program','Applied'];
    const filt = positiveStatuses.map(s => `'${s}'`).join(',');
    const r = await queryAll(conn, `SELECT Student__c FROM Olami_Activity_Engagement__c WHERE (Trip_Event_Type__c = 'Seminary' OR Trip_Event_Type__c = 'Sem Trip') AND Status__c IN (${filt}) AND Combined_start_date__c != null AND (End_Date_Combined__c >= ${fyDates.start} OR End_Date_Combined__c = null) AND Student__r.Test_Old__c = false`);
    return `${r.length} placements`;
  });

  await timed('computeSpiritualGrowth', async () => {
    const r = await queryAll(conn, `SELECT Id, Date_Became_SO__c, Date_Became_STAM__c, Date_Became_Shomer_Kashrus__c, Date_Became_Shome_Tznius__c, Date_Became_Committed_to_Marry_Jewish__c FROM Contact WHERE Test_Old__c = false AND Is_Registered_for_Souled__c > 0 AND (Date_Became_SO__c >= ${fyDates.start} OR Date_Became_STAM__c >= ${fyDates.start} OR Date_Became_Shomer_Kashrus__c >= ${fyDates.start} OR Date_Became_Shome_Tznius__c >= ${fyDates.start} OR Date_Became_Committed_to_Marry_Jewish__c >= ${fyDates.start})`);
    return `${r.length} contacts`;
  });

  await timed('computeGraduation', async () => {
    const reasons = ['Connected with in-person learning','Went to seminary','Graduated to Orthodox conversion','Graduated (became frum)'];
    const filt = reasons.map(r => `'${r}'`).join(',');
    const tpFilter = tpField ? ` AND Student__r.${tpField} >= 1` : '';
    const r = await queryAll(conn, `SELECT Id, Student__c, Stopped_Meeting_with_Coach_Reason__c FROM Registration__c WHERE RecordType.Name = 'Program' AND Program__r.Name = 'Souled' AND Stopped_Meeting_with_Coach_Reason__c IN (${filt}) AND Student__r.Test_Old__c = false${tpFilter}`);
    return `${r.length} registrations`;
  });

  await timed('computeClassesAndEvents - video', async () => {
    const r = await queryAll(conn, `SELECT Student__c FROM Class_Attendance__c WHERE Student__r.Is_Registered_for_Souled__c = 1 AND Student__r.Test_Old__c = false AND Student__r.RecordType.Name = 'Student' AND CreatedDate >= ${fyDates.start}T00:00:00Z AND CreatedDate <= ${fyDates.end}T23:59:59Z AND (Duration_in_Minutes__c >= 2 OR Watched_Recording__c >= 10) AND (RecordType.Name = 'On Demand Class' OR RecordType.Name = 'Library Item')`);
    return `${r.length} attendances`;
  });

  await timed('computeClassesAndEvents - live', async () => {
    const r = await queryAll(conn, `SELECT Student__c FROM Class_Attendance__c WHERE Student__r.Is_Registered_for_Souled__c = 1 AND Student__r.Test_Old__c = false AND Student__r.RecordType.Name = 'Student' AND CreatedDate >= ${fyDates.start}T00:00:00Z AND CreatedDate <= ${fyDates.end}T23:59:59Z AND (Duration_in_Minutes__c >= 2 OR Watched_Recording__c >= 10) AND RecordType.Name = 'Live Class'`);
    return `${r.length} attendances`;
  });

  await timed('computeClassesAndEvents - CLC', async () => {
    const r = await queryAll(conn, `SELECT Coach_Course__c, Student_Name__c FROM Contact_Coach_Course_Engagement__c WHERE Started_Date__c >= ${fyDates.start} AND Started_Date__c <= ${fyDates.end} AND (Status__c = 'Completed' OR Status__c = 'Learning')`);
    return `${r.length} engagements`;
  });

  await timed('computeClassesAndEvents - experiences', async () => {
    const r = await queryAll(conn, `SELECT Id FROM Experience__c WHERE RecordType.Name = 'Not Souled Event' AND Date__c >= ${fyDates.start} AND Date__c <= ${fyDates.end}`);
    return `${r.length} experiences`;
  });

  await timed('computeClassesAndEvents - exp attendance', async () => {
    const r = await queryAll(conn, `SELECT Student__c FROM Class_Attendance__c WHERE RecordType.Name = 'Experience' AND Student__r.Is_Registered_for_Souled__c = 1 AND Student__r.Test_Old__c = false AND CreatedDate >= ${fyDates.start}T00:00:00Z AND CreatedDate <= ${fyDates.end}T23:59:59Z`);
    return `${r.length} attendances`;
  });

  await timed('computeClassesAndEvents - engagements', async () => {
    const r = await queryAll(conn, `SELECT Student__c, Trip_Event_Type__c FROM Olami_Activity_Engagement__c WHERE Status__c = 'Attended' AND Trip_Event_Start_Da__c >= ${fyDates.start} AND Trip_Event_Start_Da__c <= ${fyDates.end}`);
    return `${r.length} engagements`;
  });

  await timed('computeAllTime', async () => {
    const r1 = await queryAll(conn, `SELECT COUNT(Id) cnt FROM Contact WHERE Is_Registered_for_Souled__c > 0 AND Test_Old__c = false`);
    const r2 = await queryAll(conn, `SELECT COUNT(Id) cnt FROM Contact WHERE Touch_Points__c > 0 AND Is_Registered_for_Souled__c > 0 AND Test_Old__c = false`);
    const r3 = await queryAll(conn, `SELECT COUNT(Id) cnt FROM Contact WHERE Touch_Points__c >= 3 AND Is_Registered_for_Souled__c > 0 AND Test_Old__c = false`);
    return `reg=${r1[0].cnt} met=${r2[0].cnt} met3+=${r3[0].cnt}`;
  });
}

main().catch(e => { console.error('top-level error:', e); process.exit(1); });
