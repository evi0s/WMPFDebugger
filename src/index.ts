import { promises } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import * as frida from "frida";
import WebSocket, { WebSocketServer } from "ws";

import { parse_cli_options, CliOptions } from "./cli";
import { CdpRouter } from "./cdp-router";
import { create_logger, Logger } from "./logger";

const codex = require("./third-party/RemoteDebugCodex.js");
const messageProto = require("./third-party/WARemoteDebugProtobuf.js");

class DebugMessageEmitter extends EventEmitter {}

const debugMessageEmitter = new DebugMessageEmitter();

const bufferToHexString = (buffer: ArrayBuffer) => {
    return Array.from(new Uint8Array(buffer))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
};

const debug_server = (options: CliOptions, logger: Logger) => {
    const wss = new WebSocketServer({ port: options.debugPort });
    logger.info(
        `[server] debug server running on ws://localhost:${options.debugPort}`,
    );
    logger.info(`[server] debug server waiting for miniapp to connect...`);

    let messageCounter = 0;

    const onMessage = (message: ArrayBuffer) => {
        logger.main_debug(
            `[miniapp] client received raw message (hex): ${bufferToHexString(message)}`,
        );
        let unwrappedData: any = null;
        try {
            const decodedData =
                messageProto.mmbizwxadevremote.WARemoteDebug_DebugMessage.decode(
                    message,
                );
            unwrappedData = codex.unwrapDebugMessageData(decodedData);
            logger.main_debug(`[miniapp] [DEBUG] decoded data:`);
            logger.main_debug(unwrappedData);
        } catch (e) {
            logger.error(`[miniapp] miniapp client err: ${e}`);
        }

        if (unwrappedData === null) {
            return;
        }

        if (unwrappedData.category === "chromeDevtoolsResult") {
            // need to proxy to CDP client
            debugMessageEmitter.emit("cdpmessage", unwrappedData.data.payload);
        }
    };

    wss.on("connection", (ws: WebSocket) => {
        logger.info("[miniapp] miniapp client connected");
        ws.on("message", onMessage);
        ws.on("error", (err) => {
            logger.error("[miniapp] miniapp client err:", err);
        });
        ws.on("close", () => {
            logger.info("[miniapp] miniapp client disconnected");
        });
    });

    debugMessageEmitter.on("proxymessage", (message: string) => {
        wss &&
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    // encode CDP and send to miniapp
                    // wrapDebugMessageData(data, category, compressAlgo)
                    const rawPayload = {
                        jscontext_id: "",
                        op_id: Math.round(100 * Math.random()),
                        payload: message.toString(),
                    };
                    logger.main_debug(rawPayload);
                    const wrappedData = codex.wrapDebugMessageData(
                        rawPayload,
                        "chromeDevtools",
                        0,
                    );
                    const outData = {
                        seq: ++messageCounter,
                        category: "chromeDevtools",
                        data: wrappedData.buffer,
                        compressAlgo: 0,
                        originalSize: wrappedData.originalSize,
                    };
                    const encodedData =
                        messageProto.mmbizwxadevremote.WARemoteDebug_DebugMessage.encode(
                            outData,
                        ).finish();
                    client.send(encodedData, { binary: true });
                }
            });
    });
};

const proxy_server = (options: CliOptions, logger: Logger) => {
    const wss = new WebSocketServer({ port: options.cdpPort });
    let activeH5Client: WebSocket | null = null;
    logger.info(
        `[server] proxy server running on ws://localhost:${options.cdpPort}`,
    );
    logger.info(
        `[server] link: devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${options.cdpPort}`,
    );

    if (options.h5Url === null) {
        const onMessage = (message: string) => {
            debugMessageEmitter.emit("proxymessage", message.toString());
        };

        wss.on("connection", (ws: WebSocket) => {
            logger.info("[cdp] CDP client connected");
            ws.on("message", onMessage);
            ws.on("error", (err) => {
                logger.error("[cdp] CDP client err:", err);
            });
            ws.on("close", () => {
                logger.info("[cdp] CDP client disconnected");
            });
        });

        debugMessageEmitter.on("cdpmessage", (message: string) => {
            wss &&
                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(message);
                    }
                });
        });

        return;
    }

    logger.info(`[h5] auto attach enabled, URL keyword: ${options.h5Url}`);

    wss.on("connection", (ws: WebSocket) => {
        if (activeH5Client !== null) {
            logger.error(
                "[cdp] rejecting CDP client: H5 mode allows only one active CDP client",
            );
            ws.close(1013, "H5 client active");
            return;
        }

        activeH5Client = ws;

        logger.info("[cdp] CDP client connected");
        const router = new CdpRouter({ h5Url: options.h5Url }, logger);

        const sendToWechat = (message: string) => {
            debugMessageEmitter.emit("proxymessage", message);
        };

        const sendToDevtools = (message: string) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        };

        router.on("wechat", sendToWechat);
        router.on("devtools", sendToDevtools);

        const onCdpMessage = (message: string) => {
            router.handleWechatMessage(message);
        };

        debugMessageEmitter.on("cdpmessage", onCdpMessage);
        router.start();

        ws.on("message", (message) => {
            router.handleDevtoolsMessage(message.toString());
        });
        ws.on("error", (err) => {
            logger.error("[cdp] CDP client err:", err);
        });
        ws.on("close", () => {
            logger.info("[cdp] CDP client disconnected");
            if (activeH5Client === ws) {
                activeH5Client = null;
            }
            router.dispose();
            router.off("wechat", sendToWechat);
            router.off("devtools", sendToDevtools);
            debugMessageEmitter.off("cdpmessage", onCdpMessage);
        });
    });
};

const frida_server = async (options: CliOptions, logger: Logger) => {
    const localDevice = await frida.getLocalDevice();
    const processes = await localDevice.enumerateProcesses({
        scope: frida.Scope.Metadata,
    });
    const wmpfProcesses = processes.filter(
        (process) => process.name === "WeChatAppEx.exe",
    );
    const wmpfPids = wmpfProcesses.map((p) =>
        p.parameters.ppid ? p.parameters.ppid : 0,
    );

    // find the parent process
    const wmpfPid = wmpfPids
        .sort(
            (a, b) =>
                wmpfPids.filter((v) => v === a).length -
                wmpfPids.filter((v) => v === b).length,
        )
        .pop();
    if (wmpfPid === undefined) {
        throw new Error("[frida] WeChatAppEx.exe process not found");
        return;
    }
    const wmpfProcess = processes.filter(
        (process) => process.pid === wmpfPid,
    )[0];
    const wmpfProcessPath = wmpfProcess.parameters.path as string | undefined;
    const wmpfVersionMatch = wmpfProcessPath
        ? wmpfProcessPath.match(/\d+/g)
        : "";
    const wmpfVersion = wmpfVersionMatch
        ? new Number(wmpfVersionMatch.pop())
        : 0;
    if (wmpfVersion === 0) {
        throw new Error("[frida] error in find wmpf version");
        return;
    }

    // attach to process
    const session = await localDevice.attach(Number(wmpfPid));

    // find hook script
    const projectRoot = path.join(
        path.dirname(
            (require.main && require.main.filename) ||
                (process.mainModule && process.mainModule.filename) ||
                process.cwd(),
        ),
        "..",
    );
    let scriptContent: string | null = null;
    try {
        scriptContent = (
            await promises.readFile(path.join(projectRoot, "frida/hook.js"))
        ).toString();
    } catch (e) {
        throw new Error("[frida] hook script not found");
        return;
    }

    let configContent: string | null = null;
    try {
        configContent = (
            await promises.readFile(
                path.join(
                    projectRoot,
                    "frida/config",
                    `addresses.${wmpfVersion}.json`,
                ),
            )
        ).toString();
        configContent = JSON.stringify(JSON.parse(configContent));
    } catch (e) {
        throw new Error(`[frida] version config not found: ${wmpfVersion}`);
    }

    if (scriptContent === null || configContent === null) {
        throw new Error("[frida] unable to find hook script");
        return;
    }

    // load script
    const script = await session.createScript(
        scriptContent.replace("@@CONFIG@@", configContent),
    );
    script.message.connect((message: frida.Message) => {
        if (message.type === "error") {
            logger.error("[frida client]", message);
            return;
        }

        logger.frida_debug("[frida client]", message.payload);
    });
    await script.load();
    logger.info(
        `[frida] script loaded, WMPF version: ${wmpfVersion}, pid: ${wmpfPid}`,
    );
    logger.info(`[frida] you can now open any miniapps`);
};

const main = async () => {
    const options = parse_cli_options();
    const logger = create_logger(options);
    debug_server(options, logger);
    proxy_server(options, logger);
    frida_server(options, logger);
};

(async () => {
    await main();
})();
