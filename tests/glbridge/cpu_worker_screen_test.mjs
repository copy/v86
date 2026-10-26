import assert from "node:assert/strict";
import { CPUWorkerController } from "../../src/browser/cpu_worker.js";

// A text redraw burst can exceed the engine's function argument limit.
// Drive the actual receiver and dispatch, checking order and epoch filtering.
// The page sends each character's screen-put-char (the worker does not),
// once the screen adapter has the character.
const controller = Object.create(CPUWorkerController.prototype);
let expected = 0, events = 0;
controller.epoch = 7;
controller.screen_queue = [];
controller.emulator = {
    screen_adapter: { put_char(index, row, character) {
        assert.equal(index, expected++);
        assert.equal(row, 0);
        assert.equal(character, 65);
    } },
    emulator_bus: { send(name, value) {
        assert.equal(name, "screen-put-char");
        assert.deepEqual(value, [events, 0, 65]);
        assert.equal(expected, ++events, "the event after the character");
    } },
};
const commands = Array.from({ length: 300000 }, (_, i) => ["put_char", [i, 0, 65]]);
controller.receive({ type: "screen", epoch: 6, commands });
assert.equal(expected, 0, "discard stale screen updates");
controller.receive({ type: "screen", epoch: 7, commands });
assert.equal(expected, commands.length, "deliver every command in order");
assert.equal(controller.screen_queue.length, 0);
controller.receive({ type: "screen", epoch: 7, commands: [] });
controller.receive({ type: "screen", epoch: 7, commands: [["put_char", [expected, 0, 65]]] });
assert.equal(expected, 300001, "continue receiving after a large burst");
assert.equal(events, expected, "one screen-put-char a character");
console.log("PASS: 300000-command Worker screen burst, order, stale epoch and subsequent update, the characters' events");
