import assert from "node:assert/strict";
import {inspect_reset_resources_wire} from "./d3d_reset_resources_wire.mjs";

// Reuse the independently decoded resource/pixel trace only after validating
// the added HRESULT observations. Lost Presents must add no wire frames.
export function inspect_reset_status_wire(bytes, result) {
    const logs = {...result.logs}, statuses = [];
    for (const api of [8, 9]) {
        const file = "RST" + api + ".TXT";
        const lines = logs[file].replace(/\r/g, "").trim().split("\n");
        assert.equal(lines.length, 3);
        const resetHR = api === 8 ? "88760868" : "8876086C";
        assert.equal(lines[1], "RESET STATUS " + api + " refused=7 recovered=15 lostPresents=7 coopNotReset=28 coopReady=15 resetHR=" + resetHR + " coopHR=88760869 presentHR=88760868");
        logs[file] = lines[0] + "\n" + lines[2];
        statuses.push({api, refusedResets: 7, successfulResets: 15, lostPresents: 7, notResetQueries: 28, readyQueriesAfterReset: 15, resetHR, cooperativeHR: "88760869", presentHR: "88760868"});
    }
    return {...inspect_reset_resources_wire(bytes, {...result, logs}), statuses};
}
