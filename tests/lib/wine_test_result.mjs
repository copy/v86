// A completed process is not sufficient: Wine can skip every test and exit 0.
import assert from "node:assert/strict";
export function parse_wine_result(log, name) {
    const summaries=[...log.matchAll(/(\d+) tests executed \((\d+) marked as todo, (\d+) as flaky, (\d+) failures?\), (\d+) skipped\./g)];
    assert.equal(summaries.length,1,"Missing or duplicate Wine completion summary: "+name);
    const [checks,todos,flaky,failures,skipped]=summaries[0].slice(1).map(Number);
    assert(checks>1000,"Wine suite did not execute: "+name);
    assert.deepEqual([todos,flaky,failures,skipped],[0,0,0,0],"Wine conformance failure: "+name);
    assert(!log.includes("Test failed:"),"Wine failure contradicts summary: "+name);
    assert.match(log,/exit=0\s*$/,"Wine process did not exit successfully: "+name);
    return {checks,todos,flaky,failures,skipped};
}
