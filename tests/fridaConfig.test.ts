import assert from "node:assert/strict";
import path from "node:path";

import {
    createUnsupportedVersionMessage,
    readVersionConfig,
} from "../src/fridaConfig";

const message = createUnsupportedVersionMessage(19977, [19201, 19027, 19459]);

assert.match(message, /version config not found: 19977/);
assert.match(message, /supported versions: 19027, 19201, 19459/);
assert.match(message, /frida\/config\/addresses\.19977\.json/);

(async () => {
    const config19459 = JSON.parse(
        await readVersionConfig(path.join(__dirname, ".."), 19459),
    );

    assert.equal(config19459.Version, 19459);
    assert.deepEqual(config19459.SceneOffsets, [1376, 1312, 456]);

    const config19977 = JSON.parse(
        await readVersionConfig(path.join(__dirname, ".."), 19977),
    );

    assert.equal(config19977.Version, 19977);
    assert.equal(config19977.LoadStartHookOffset, "0x25D14B0");
    assert.equal(config19977.CDPFilterHookOffset, "0x30B02B0");
    assert.deepEqual(config19977.SceneOffsets, [64, 1480, 8, 1416, 16, 456]);

    console.log("fridaConfig tests passed");
})();
