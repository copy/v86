import assert from "node:assert/strict";
import {parse_wine_result,assert_wine_graphics_cleanup} from "../lib/wine_test_result.mjs";
const passed="0180:stateblock: 9283 tests executed (0 marked as todo, 0 as flaky, 0 failures), 0 skipped.\r\nexit=0 \r\n";
assert.deepEqual(parse_wine_result(passed,"8"),{checks:9283,todos:0,flaky:0,failures:0,skipped:0});
assert.equal(parse_wine_result("RUNNING Wine9\n"+passed.replace("9283","14738"),"9").checks,14738);
assert.equal(parse_wine_result(passed.replace("9283","100"),"named group",{minimumChecks:100}).checks,100);
assert.throws(()=>parse_wine_result(passed.replace("9283","99"),"short group",{minimumChecks:100}));
for(const minimumChecks of [0,-1,NaN,1.5])assert.throws(()=>parse_wine_result(passed,"invalid threshold",{minimumChecks}));
for(const log of ["", "exit=0\n", passed.replace("9283","0"),passed.replace("9283","1"),passed.replace("0 failures","16 failures"),passed.replace("0 failures","1 failure"),passed.replace("0 marked","1 marked"),passed.replace("0 as flaky","1 as flaky"),passed.replace("0 skipped","1 skipped"),passed.replace("exit=0","exit=16"),passed.replace("exit=0", ""),passed+passed,"Test failed: wrong state\n"+passed])assert.throws(()=>parse_wine_result(log,"invalid"));
console.log("PASS Wine result gate: two real suite counts, 13 incomplete/failed/skipped/contradictory results rejected");
const skip="device.c:123: Tests skipped: Alternative unsupported-format branch.\r\n";
const reviewed={location:"device.c:123",message:"Alternative unsupported-format branch.",category:"mutually-exclusive",reason:"The supported-format branch executed instead.",evidence:["Pinned source condition and successful runtime format query"],count:1};
const withSkip=skip+passed.replace("0 skipped","1 skipped");
assert.equal(parse_wine_result(withSkip,"reviewed",{inapplicable:[reviewed]}).skipped,1);
for(const row of [{...reviewed,reason:""},{...reviewed,evidence:[]},{...reviewed,category:"missing-feature"},{...reviewed,count:0},{...reviewed,count:2},{...reviewed,location:"device.c:124"},{...reviewed,message:"Different branch"}])
    assert.throws(()=>parse_wine_result(withSkip,"bad applicability",{inapplicable:[row]}));
assert.throws(()=>parse_wine_result(withSkip,"duplicate",{inapplicable:[reviewed,reviewed]}));
assert.throws(()=>parse_wine_result(passed,"unused",{inapplicable:[reviewed]}));
assert.throws(()=>parse_wine_result(skip+passed,"contradictory"));
assert.throws(()=>parse_wine_result(withSkip.replace("0 failures","1 failure"),"actual failure",{inapplicable:[reviewed]}));
console.log("PASS reviewed applicability: exact location/message/count, reason/evidence, categories and contradictions; failures remain fatal");
const cleaned={devices:0,resources:0,sessions:0,sessionCleanup:[{devices:1,resources:3,after:{devices:0,resources:0,pendingFrame:false,activeQuery:false}}]};
assert_wine_graphics_cleanup(cleaned);
for(const after of [undefined,{...cleaned.sessionCleanup[0].after,devices:1},{...cleaned.sessionCleanup[0].after,resources:1},{...cleaned.sessionCleanup[0].after,pendingFrame:true},{...cleaned.sessionCleanup[0].after,activeQuery:true}])
    assert.throws(()=>assert_wine_graphics_cleanup({...cleaned,sessionCleanup:[{after}]}));
for(const field of ['devices','resources','sessions'])assert.throws(()=>assert_wine_graphics_cleanup({...cleaned,[field]:1}));
assert.throws(()=>assert_wine_graphics_cleanup({...cleaned,sessionCleanup:[]}));
console.log('PASS owner cleanup gate: retain pre-cleanup counts; reject surviving graphics state, sessions or missing post-cleanup evidence');
