## Shared knowledge — Olami/Souled wiki

Before answering any domain question about student retention, status
transitions, or enrollment rollups, read `~/knowledge/wiki/index.md`
first. Most relevant pages for this repo:

- `~/knowledge/wiki/concepts/registration.md`
- `~/knowledge/wiki/concepts/contact.md`
- `~/knowledge/wiki/concepts/relationship.md`
- `~/knowledge/wiki/concepts/touch-point.md`
- `~/knowledge/wiki/concepts/so-stam-assessment.md`
- `~/knowledge/wiki/concepts/api-name-typos.md`

Treat the wiki as authoritative. Hard rules:

- `Date_Became_SO__c` is the canonical SO date.
- Test-record exclusion: `Test_Old__c = false AND NOT Name LIKE '%test%'`.
- UTM/Meta filter: `utm_source__c IN ('facebook','ig','fb')`.

If the wiki is missing a topic that comes up here, flag it.
Wiki repo: github.com/Olami-Souled/knowledge.