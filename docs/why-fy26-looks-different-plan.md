# "Why FY26 Looks Different" — Overlay Story on the Souled Students Chart

## Context

Souled has fewer students this FY than last. Benji asked Yair to prepare a visualization that explains *why* — so leadership doesn't read the dip as the team "slacking off." Two structural drivers explain most of the gap:

1. **Multiple coaches went on maternity leave simultaneously early in the year** — coach capacity dropped, so the program physically couldn't accept as many students.
2. **Meta CPL jumped ~3-4x in mid-January** ($40-50 → $150-200) — same recruiting effort produced far fewer leads.

We already have the **"Number of Souled Students"** tab with a daily-history line chart. The cleanest way to communicate the story is to **overlay capacity and real CPL on the same chart** so the cause-and-effect is visually obvious. The user can toggle each overlay on/off, and the timeline alignment does the explaining.

---

## Approach

**Single tab, toggleable overlays — no new "context" page.**

Below the existing chart controls (date pickers + Daily/Weekly/Monthly toggle), add a row of overlay checkboxes:

```
Show on chart:  ☑ Souled Students   ☐ Total Capacity   ☐ Current Capacity   ☐ Real CPL
```

- **Souled Students** — existing line, always on.
- **Total Capacity** — sum across all Souled coaches of `Total_One_On_One_Capacity__c` (the structural max).
- **Current Capacity** — sum across all Souled coaches of `One_On_One_Capacity__c` (today's effective capacity, which dips when coaches go on leave / are ramping up / etc.).
- **Real CPL** — Meta spend ÷ new Souled Registration__c records, plotted on a **secondary right-side Y-axis** (different unit: dollars).

When CPL is enabled, Chart.js draws a dual-axis: students/capacity on the left ($-counts), CPL on the right ($).

The Daily/Weekly/Monthly granularity toggle controls **all** overlays uniformly.

---

## Data Sources

### Capacity (both Total and Current)

**Source:** `ContactHistory` on the Contact (coach) records. Capacity fields:
- `Total_One_On_One_Capacity__c` — coach's structural max (label confusingly says "One On One Capacity")
- `One_On_One_Capacity__c` — coach's current effective capacity (label says "Current One On One Capacity")

**History coverage:** Both go back to **Oct 21, 2024** (324 and 538 records respectively) — full coverage of the FY25/FY26 story.

**Algorithm (per day, per field):**
1. **Identify all coaches who had a Souled relationship overlapping the reporting window** — NOT just current employees. A coach who was active Sept-Dec 2025 and has since left must still contribute their historical capacity.

   Coach-set query:
   ```sql
   SELECT DISTINCT Mentor__c FROM Relationship__c
   WHERE Type__c = 'Souled Coach'
     AND Start_Date__c <= <endDate>
     AND (End_Date__c >= <startDate> OR End_Date__c = null)
   ```
   Then **exclude test contacts** by removing any Mentor__c that's in the existing in-memory `testIds` set built by `getTestContactIds()` at server startup.

2. For each coach in that set, build a daily time series of their capacity by walking `ContactHistory` chronologically and applying the carry-forward pattern from `/api/matched-students-history`.
   - Seed value = the most recent ContactHistory entry **before** `startDate` (could be null for coaches whose first capacity was set inside the window).
   - For days with no history change, carry forward last known value.
   - If a coach's capacity becomes 0 mid-period (e.g., they fully left), they correctly stop contributing from that day forward.

3. For each day, sum the per-coach values → program-wide total.

4. Aggregate to weekly/monthly when granularity ≠ daily (mean of daily totals — same logic as existing endpoint).

**Why this matters:** This is the user's specific concern — coaches who went on maternity leave and didn't return, or who left for unrelated reasons during the period, MUST still be counted in their pre-departure days. Filtering by current-employment status would erase the very capacity dip we're trying to visualize.

**Sanity check:** For dates ≥ Feb 5, 2026, the program-level rollup `Program__c.One_on_One_Cpacity__c` (note the typo — see API Names section) has its own history. Compare the summed-coach series against the program rollup for those dates; they should agree within tolerance.

Today's totals: `One_on_One_Cpacity__c = 801`, `Current_One_on_One_Capacity__c = 661` — use these to spot-check the implementation.

### Real CPL

**Numerator (Meta spend):** Windsor.ai Facebook connector
- Connector ID: `facebook`
- Account ID: `548376353109705` (account name: "Souled" — already program-specific, no campaign filter needed)
- Field: `spend`, grouped by `date`

**Denominator (new Souled students):** Salesforce SOQL via existing jsforce connection
- `SELECT COUNT(Id) FROM Registration__c WHERE Program__r.Name = 'Souled' AND Student__r.Test_Old__c = false AND CreatedDate >= start AND CreatedDate <= end` — bucketed by day.
- Per the user's chosen definition: any new Registration__c on the Souled program; no disqualification filter.
- **Exclude test students**: filter out Registration__c rows where `Student__r.Test_Old__c = true` (or use the existing in-memory `testIds` set built by `getTestContactIds()` in `server.js`, which is already loaded at server startup — preferred for consistency with the rest of the dashboard).

**CPL formula:** `cpl[period] = sum(spend[period]) / sum(new_registrations[period])`. If the period denominator is 0, CPL is null/skipped.

**Granularity:**
- Daily: per-day spend ÷ per-day new registrations. Will be noisy (some days have 0 registrations → null gaps).
- Weekly: 7-day Sun-Sat windows summed top and bottom, then divided.
- Monthly: same with calendar months.

### "Number of Souled Students" (existing — no change)

Already implemented via `Program__History` on `Matched_Students__c` → `/api/matched-students-history`.

---

## Backend Changes (`server.js`)

### New endpoint: `/api/student-overlays`

Single endpoint that returns ANY combination of overlays, so the frontend can fetch in one round-trip:

```
GET /api/student-overlays?
  start=2025-09-01&end=2026-04-19&granularity=daily&
  include=capacity,currentCapacity,cpl
```

Response shape:
```json
{
  "startDate": "2025-09-01",
  "endDate":   "2026-04-19",
  "granularity": "daily",
  "earliestAvailable": "2024-10-21",  // from ContactHistory
  "series": {
    "capacity":         [{"date":"2025-09-01","value":820}, ...],
    "currentCapacity":  [{"date":"2025-09-01","value":705}, ...],
    "cpl":              [{"date":"2025-09-01","value":42.10}, ...]
  }
}
```

**Implementation notes:**
- Reuse the **carry-forward + bucket-aggregate** logic from `computeMatchedStudentsHistory` (the function added with `/api/matched-students-history`). Extract it into a helper `buildDailySeriesFromHistory(records, start, end, seedValue)` so capacity and matched-students share it.
- Coach identification query: query Contact for `program_employed_by__c = 'Souled'` (verify field name — the skill mentions it but doesn't confirm exact value). Cache the coach list per request.
- For CPL, add a small Windsor.ai HTTP client (or call via the MCP layer if present in deploy environment). **For Railway deployment, MCP tools aren't available — use the Windsor.ai REST API directly with an API key stored in `.env` as `WINDSOR_API_KEY`.** Need to confirm this key exists / generate one. Ask the user during implementation.
- Add an in-memory cache (5-min TTL) on the Windsor spend response keyed by `(start, end)` to avoid hitting their API on every chart toggle.

### New helper function

`async function getSouledCoachIds(conn)` — returns the list of coach Contact IDs. Memoize per request.

### Helper extraction

Pull the day-series builder out of the matched-students endpoint into a reusable function so the same carry-forward logic powers all four series.

---

## Frontend Changes

### `public/index.html`

Add an overlay-controls row inside the `#students-view` block, between the existing date/granularity controls and the chart container:

```html
<div class="overlay-controls">
  <span class="overlay-label">Show on chart:</span>
  <label><input type="checkbox" data-overlay="capacity"> Total Capacity</label>
  <label><input type="checkbox" data-overlay="currentCapacity"> Current Capacity</label>
  <label><input type="checkbox" data-overlay="cpl"> Real CPL ($)</label>
</div>
```

### `public/executive.css`

Add `.overlay-controls` styling — similar visual weight to `.students-controls`, inline pill/checkbox row.

### `public/executive.js`

Modify the `loadStudentsChart()` function and supporting state:

1. Track `enabledOverlays = new Set()` in module scope.
2. On checkbox change: update the set, then call `loadStudentsChart()`.
3. Inside `loadStudentsChart`:
   - Build the URL: always fetch `/api/matched-students-history` AND, if any overlays are on, ALSO fetch `/api/student-overlays?include=...`.
   - Merge the response into `chart.data.datasets`:
     - Souled Students — left axis, blue (existing).
     - Total Capacity — left axis, green dashed.
     - Current Capacity — left axis, orange.
     - Real CPL — **right axis** (dollars), red.
   - Configure dual Y-axis only when `cpl` is in the set:
     ```js
     scales: {
       y:  { position: 'left',  title: { text: 'Students / Capacity' } },
       y1: { position: 'right', title: { text: 'CPL ($)' }, grid: { drawOnChartArea: false } }
     }
     ```
4. Tooltip should show all enabled series at the hovered date.

---

## Memory Update (post-execution)

User's standing rule (added this session): **"When I tell you personal preferences always add them to my memory. Including this rule."** This belongs in user-level memory (applies across all projects), not project memory.

### User-level memory (`~/.claude/CLAUDE.md` or equivalent global memory)

```
- RULE: When the user states a personal preference or working style, add it to memory immediately.
- Preference: Yair prefers intuitive/descriptive filenames (avoid auto-generated random names when there's a natural name).
- Preference: When finishing a project, update relevant skills and consider creating new ones for newly-discovered domains (e.g. Meta marketing data).
```

### Project memory (`C:\Users\ypspo\.claude\projects\C--Users-ypspo-Documents-Claude-Projects-Souled-Retention-Report\memory\MEMORY.md`)

```
- Windsor.ai MCP is connected (connector tools mcp__a739fb41-9c14-41fc-8240-72026c50b85e__*).
  Use it for Meta/Google Ads/GA4/Instagram data. Souled Facebook account ID: 548376353109705.
  ALWAYS prefer SF CLI over Windsor for Salesforce data per olami-salesforce-schema skill.
- Souled Program__c ID: a2F5f000000yRpfEAE.
- Capacity field typo on Program__c: One_on_One_Cpacity__c (missing "a").
- Capacity field history is on ContactHistory back to 2024-10-21; on Program__History only since 2026-02-05.
- Use the existing in-memory `testIds` set (built by `getTestContactIds()` at server startup) to exclude
  test contacts from any new query — same pattern as the rest of server.js.
```

(Memory files aren't in the plan file path so I can't edit them during plan mode. These are the first edits after plan approval.)

---

## Files to Modify

| File | Change |
|------|--------|
| `server.js` | Add `/api/student-overlays`; extract day-series builder helper; add Windsor.ai REST client + 5-min cache |
| `public/index.html` | Add overlay-controls row inside `#students-view` |
| `public/executive.css` | Style `.overlay-controls` |
| `public/executive.js` | Track enabled overlays; refactor `loadStudentsChart()` to merge multiple series with dual Y-axis when CPL is on |
| `package.json` | Possibly add `node-fetch` (or use built-in `fetch` if Node 18+) for Windsor calls |
| `.env` (locally + Railway) | Add `WINDSOR_API_KEY` (need to obtain) |
| Project MEMORY.md | Add Windsor.ai notes (post-approval, separate edit) |

---

## Verification

1. **Local API smoke test**:
   ```bash
   curl 'http://localhost:3000/api/student-overlays?start=2025-09-01&end=2026-04-19&granularity=monthly&include=capacity,currentCapacity,cpl'
   ```
   - `capacity` April value should sit near 801 (today's `One_on_One_Cpacity__c`).
   - `currentCapacity` April value should sit near 661 (today's `Current_One_on_One_Capacity__c`).
   - `cpl` should show Sep–Dec values around $40-50, then a step up to $150-200 starting mid-January 2026.

2. **Cross-check capacity vs Program rollup** (Feb 5, 2026 onward):
   ```sql
   SELECT NewValue, CreatedDate FROM Program__History
   WHERE ParentId='a2F5f000000yRpfEAE' AND Field='One_on_One_Cpacity__c'
   ORDER BY CreatedDate DESC LIMIT 5
   ```
   The summed-coach series for those dates should be within ±2 of these values (rounding/timing).

3. **UI test** in preview server:
   - Toggle each overlay individually → only that line appears.
   - Toggle CPL on → right Y-axis appears with $ scale; CPL line is on the right.
   - Switch Daily → Weekly → Monthly → all enabled overlays re-render with the new buckets.
   - Change start date → all overlays clip to the new range.

4. **Story sanity check**: With ALL overlays on for Sep 1, 2025 → today, weekly granularity:
   - The Sep-Dec capacity dip should visually correlate with the early student-count drop.
   - The mid-January CPL spike should visually correlate with the renewed student-count decline through Q1 2026.
   - If the chart doesn't tell that story clearly, revisit the granularity defaults or labels.

5. **Railway deploy** verification (after merge to `main`): same UI test against `https://souled-executive-dashboard.up.railway.app/index.html`.

---

## Open Items to Resolve at Implementation Time

1. **Souled coach identification** is via `Relationship__c WHERE Type__c = 'Souled Coach'` overlapping the reporting window — confirmed approach. Will sanity-check during impl that `'Souled Coach'` is the exact string value (vs. variants like "Souled - Coach").
2. **Windsor.ai REST API key**: need to confirm Yair has one (or that the MCP-only flow works on Railway). If MCP isn't available server-side, we either get a key or proxy through a local-only setup.
3. **Verify `Program__r.Name = 'Souled'` is the right registration filter** vs. `Program__c = 'a2F5f000000yRpfEAE'`. Both should work; the ID-based filter is faster and not subject to renames.

---

## Skills Updates (Post-Implementation)

### Update existing: `anthropic-skills:olami-salesforce-schema`

Append/update sections with what we learned during this build:

- **Contact (capacity fields)** — add to the Coaching subsection:
  - `Total_One_On_One_Capacity__c` (label: "One On One Capacity") — coach's structural max
  - `One_On_One_Capacity__c` (label: "Current One On One Capacity") — coach's effective current
  - `Remaining_One_On_One_Capacity__c`
  - `Current_One_On_One_Capacity_Reason__c` (picklist) — values include: "On Maternity Leave", "Slowing down before maternity", "Ramping Up", "Has Not Started", "Temporary slowdown", "Slowing down before leaving"
  - `Capacity_Note__c` (textarea)
  - **History note**: `Total_One_On_One_Capacity__c` and `One_On_One_Capacity__c` have ContactHistory back to Oct 21, 2024. The Reason picklist does NOT have history tracking enabled.

- **Program__c** — expand the section:
  - Add ID: Souled = `a2F5f000000yRpfEAE`
  - Add field: `Current_One_on_One_Capacity__c`, `Total_Remaining_One_on_One_Capacity__c`
  - **History note**: Program-level capacity rollup history begins Feb 5, 2026 only. For earlier dates, sum coach-level history.

- **API Name Typos to Remember** — already lists `one_on_one_cpacity__c`; confirm it's noted that this is on Program__c (not Contact, where the name is correct).

### New skill: `olami-meta-marketing` (recommended)

The schema skill briefly mentions the Souled pixel and CAPI in passing, but Meta data lives in a different system (Windsor.ai → Facebook). A dedicated skill reduces friction next time.

**Suggested contents:**
- **Windsor.ai connector**: ID `a739fb41-9c14-41fc-8240-72026c50b85e`, tools `mcp__a739fb41-9c14-41fc-8240-72026c50b85e__*`. Connectors available: facebook, instagram, googleanalytics4, salesforce.
- **Facebook ad accounts**:
  - Souled: `548376353109705` (dedicated)
  - Olami Global: `799308954217783`
  - Olami Mentorship: `394321120431198`
- **Souled Meta Pixel**: `942524968208804`
- **Souled Offline Conversions dataset**: `2011867859681592` (cross-ref the SF schema skill)
- **"Real CPL" definition**: Meta spend on Souled FB account ÷ count of new Souled `Registration__c` (excluding test contacts). This is the canonical CPL for Souled — NOT Meta's reported CPL, which uses Meta's own lead count.
- **Common patterns**:
  - Get spend by day for a Souled campaign: `get_data(connector='facebook', accounts=['548376353109705'], fields=['date','spend'], date_from=..., date_to=...)`
  - Get CAPI logs for a contact: SOQL on `meta_logs__c WHERE contact__c = '...'` (link to the SF schema skill's pattern)
- **CAPI debugging cross-ref**: see `meta_logs__c` in the SF schema skill — use that for debugging individual contact events; use Windsor for aggregate/spend questions.

I'll use the `anthropic-skills:skill-creator` skill to scaffold this properly.

---

## Plan File Naming

The filename `sunny-percolating-squid.md` is auto-generated by Claude Code's plan-mode harness — I can't rename it during plan mode (the harness only allows editing the named plan file). After approval, I'll copy this plan into the project repo at `docs/why-fy26-looks-different-plan.md` (or similar) so it's easy to reference and version-controlled.
