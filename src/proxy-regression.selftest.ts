import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join(__dirname, "index.ts"), "utf8");

const assert = (condition: unknown, message: string) => {
    if (!condition) {
        throw new Error(message);
    }
};

assert(
    source.includes("if (options.h5Url === null)"),
    "proxy_server must keep an explicit raw non-H5 branch",
);

assert(
    source.includes("client.send(message);"),
    "raw non-H5 branch must broadcast WeChat CDP payloads directly to DevTools clients",
);

assert(
    source.includes('debugMessageEmitter.emit("proxymessage", message.toString())'),
    "raw non-H5 branch must forward DevTools messages directly to the miniapp bridge",
);

console.log("proxy regression selftest passed");
