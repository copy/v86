// A completed process is not sufficient: Wine can skip every test and exit 0.
import assert from "node:assert/strict";
export function parse_wine_result(log, name, {minimumChecks = 1001, inapplicable = []} = {}) {
    const summaries=[...log.matchAll(/(\d+) tests executed \((\d+) marked as todo, (\d+) as flaky, (\d+) failures?\), (\d+) skipped\./g)];
    assert.equal(summaries.length,1,"Missing or duplicate Wine completion summary: "+name);
    const [checks,todos,flaky,failures,skipped]=summaries[0].slice(1).map(Number);
    assert(Number.isInteger(minimumChecks) && minimumChecks > 0, "Invalid minimum check count");
    assert(checks>=minimumChecks,"Wine suite did not execute: "+name);
    assert.deepEqual([todos,flaky,failures],[0,0,0],"Wine conformance failure: "+name);
    assert(!log.includes("Test failed:"),"Wine failure contradicts summary: "+name);
    assert.match(log,/exit=0\s*$/,"Wine process did not exit successfully: "+name);
    // Only individually reviewed, source-pinned platform/alternative branches
    // can be inapplicable. Missing graphics functionality is not an exclusion.
    assert(Array.isArray(inapplicable), "Invalid Wine applicability records");
    const records = new Map();
    for (const row of inapplicable) {
        assert(row && /^(platform|mutually-exclusive)$/.test(row.category), "Invalid applicability category");
        assert(/^[\w.-]+\.c:\d+$/.test(row.location) && typeof row.message === "string" && row.message.trim(), "Missing exact skip identity");
        assert(typeof row.reason === "string" && row.reason.trim(), "Missing applicability reason");
        assert(Array.isArray(row.evidence) && row.evidence.length && row.evidence.every(s => typeof s === "string" && s.trim()), "Missing applicability evidence");
        assert(Number.isInteger(row.count) && row.count > 0, "Invalid applicability occurrence count");
        const key = row.location + ": " + row.message;
        assert(!records.has(key), "Duplicate applicability record");
        records.set(key, {row, observed: 0});
    }
    const skippedLines = [...log.matchAll(/^([\w.-]+\.c:\d+): Tests skipped: ([^\r\n]*)/gm)];
    assert.equal(skippedLines.length, skipped, "Wine skip lines contradict summary: " + name);
    for (const [, location, message] of skippedLines) {
        const record = records.get(location + ": " + message);
        assert(record, "Unreviewed Wine skip: " + location + ": " + message);
        ++record.observed;
    }
    for (const {row, observed} of records.values()) assert.equal(observed, row.count, "Applicability evidence does not match this run: " + row.location);
    return {checks,todos,flaky,failures,skipped, ...(skipped ? {inapplicable} : {})};
}
