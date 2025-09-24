import { promises } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import * as frida from "frida";
import WebSocket, { WebSocketServer } from "ws";

const codex = require("./third-party/RemoteDebugCodex.js");
const messageProto = require("./third-party/WARemoteDebugProtobuf.js");


class DebugMessageEmitter extends EventEmitter {};


// default debugging port, do not change
const DEBUG_PORT = 9421;
// CDP port, change to whatever you like
// use this port by navigating to devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${CDP_PORT}
const CDP_PORT = 62000;
// debug switch
const DEBUG = false;

const debugMessageEmitter = new DebugMessageEmitter();

const bufferToHexString = (buffer: ArrayBuffer) => {
    return Array.from(new Uint8Array(buffer)).map(byte => byte.toString(16).padStart(2, '0')).join("");
}

const debug_server = () => {
    const wss = new WebSocketServer({ port: DEBUG_PORT });
    console.log(`[server] debug server running on ws://localhost:${DEBUG_PORT}`);

    let messageCounter = 0;

    const onMessage = (message: ArrayBuffer) => {
        DEBUG && console.log(`[client] received raw message (hex): ${bufferToHexString(message)}`);
        let unwrappedData: any = null;
        try {
            const decodedData = messageProto.mmbizwxadevremote.WARemoteDebug_DebugMessage.decode(message);
            unwrappedData = codex.unwrapDebugMessageData(decodedData);
            DEBUG && console.log(`[client] [DEBUG] decoded data:`);
            DEBUG && console.dir(unwrappedData)
        } catch (e) {
            console.error(`[client] err: ${e}`);
        }

        if (unwrappedData === null) {
            return;
        }

        if (unwrappedData.category === "chromeDevtoolsResult") {
            // need to proxy to CDP client
            debugMessageEmitter.emit("cdpmessage", unwrappedData.data.payload);
        }
    }

    wss.on("connection", (ws: WebSocket) => {
        console.log("[conn] miniapp client connected");
        ws.on("message", onMessage);
        ws.on("error", (err) => {console.error("[client] err:", err)});
        ws.on("close", () => {console.log("[client] client disconnected")});
    });

    debugMessageEmitter.on("proxymessage", (message: string) => {
        wss && wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                // encode CDP and send to miniapp
                // wrapDebugMessageData(data, category, compressAlgo)
                const rawPayload = {
                    jscontext_id: "",
                    op_id: Math.round(100 * Math.random()),
                    payload: message.toString()
                };
                DEBUG && console.log(rawPayload);
                const wrappedData = codex.wrapDebugMessageData(rawPayload, "chromeDevtools", 0);
                const outData = {
                    seq: ++messageCounter,
                    category: "chromeDevtools",
                    data: wrappedData.buffer,
                    compressAlgo: 0,
                    originalSize: wrappedData.originalSize
                }
                const encodedData = messageProto.mmbizwxadevremote.WARemoteDebug_DebugMessage.encode(outData).finish();
                client.send(encodedData, { binary: true });
            }
        });
    });
}

const proxy_server = () => {
    const wss = new WebSocketServer({ port: CDP_PORT });
    console.log(`[server] proxy server running on ws://localhost:${CDP_PORT}`);

    const onMessage = (message: string) => {
        debugMessageEmitter.emit("proxymessage", message);
    }

    wss.on("connection", (ws: WebSocket) => {
        console.log("[conn] CDP client connected");
        ws.on("message", onMessage);
        ws.on("error", (err) => {console.error("[client] CDP err:", err)});
        ws.on("close", () => {console.log("[client] CDP client disconnected")});
    });

    debugMessageEmitter.on("cdpmessage", (message: string) => {
        wss && wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                // send CDP message to devtools
                client.send(message);
            }
        });
    });
}

const frida_server = async () => {
    const localDevice = await frida.getLocalDevice();
    const processes = await localDevice.enumerateProcesses({scope: frida.Scope.Metadata});
    const wmpfProcesses = processes.filter(process => process.name === "WeChatAppEx.exe");
    const wmpfPids = wmpfProcesses.map(p => p.parameters.ppid ? p.parameters.ppid : 0);

    // find the parent process
    const wmpfPid = wmpfPids.sort((a, b) => wmpfPids.filter(v => v === a).length - wmpfPids.filter(v => v === b).length).pop();
    if (wmpfPid === undefined) {
        throw new Error("[frida] WeChatAppEx.exe process not found");
        return;
    }
    const wmpfProcess = processes.filter(process => process.pid === wmpfPid)[0];
    const wmpfProcessPath = wmpfProcess.parameters.path as string | undefined;
    const wmpfVersionMatch = wmpfProcessPath ? wmpfProcessPath.match(/\d+/g) : "";
    const wmpfVersion = wmpfVersionMatch ? new Number(wmpfVersionMatch.pop()) : 0;
    if (wmpfVersion === 0) {
        throw new Error("[frida] error in find wmpf version");
        return;
    }

    // attach to process
    const session = await localDevice.attach(Number(wmpfPid));

    // find hook script
    const projectRoot = path.join(path.dirname(require.main && require.main.filename || process.mainModule && process.mainModule.filename || process.cwd()), "..");
    let scriptContent: string | null = null;
    try {
        scriptContent = (await promises.readFile(path.join(projectRoot, "frida/hook.js"))).toString();
    } catch (e) {
        throw new Error("[frida] hook script not found");
        return;
    }

    let configContent: string | null = null;
    try {
        configContent = (await promises.readFile(path.join(projectRoot, "frida/config", `addresses.${wmpfVersion}.json`))).toString();
        configContent = JSON.stringify(JSON.parse(configContent));
    } catch(e) {
        throw new Error(`[frida] version config not found: ${wmpfVersion}`);
    }

    if (scriptContent === null || configContent === null) {
        throw new Error("[frida] unable to find hook script");
        return;
    }

    // load script
    const script = await session.createScript(scriptContent.replace("@@CONFIG@@", configContent));
    script.message.connect(message => {
        console.log("[frida client]", message);
    });
    await script.load();
    console.log(`[frida] script loaded, WMPF version: ${wmpfVersion}, pid: ${wmpfPid}`);
}

const main = async () => {
    debug_server();
    proxy_server();
    frida_server();
}

(async () => {
    await main();
})();



