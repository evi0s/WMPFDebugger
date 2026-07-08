import { promises } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import * as frida from "frida";
import WebSocket, { WebSocketServer } from "ws";

import { parse_cli_options, CliOptions } from "./cli";
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

const tryParseJson = (value: string) => {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
};

const APPSERVICE_CONTEXT_PROBE_EXPRESSION = `(() => ({
    ok: true,
    hasLocation: typeof location !== "undefined",
    hasWx: typeof wx !== "undefined",
    hasRequire: typeof require !== "undefined",
    href: typeof location !== "undefined" ? location.href : null,
}))()`;

const debug_server = (
    options: CliOptions,
    logger: Logger,
    initScriptSource: string,
) => {
    const wss = new WebSocketServer({ port: options.debugPort });
    logger.info(
        `[server] debug server running on ws://localhost:${options.debugPort}`,
    );
    logger.info(`[server] debug server waiting for miniapp to connect...`);

    let messageCounter = 0;
    let nextProbeScriptInjectionId = 100_000;
    const pendingProbeScriptInjectionResults = new Map<
        number,
        {
            executionContextId: number;
            frameId: string | null;
            sessionId: string | null;
        }
    >();
    const probeScriptInjectedContexts = new Set<string>();
    let nextInitScriptInjectionId = 200_000;
    const pendingInitScriptInjectionResults = new Map<
        number,
        {
            executionContextId: number;
            frameId: string | null;
            sessionId: string | null;
        }
    >();
    const initScriptInjectedContexts = new Set<string>();
    let candidate:
        | {
              executionContextId: number;
              frameId: string | null;
              sessionId: string | null;
          }
        | null = null;

    const sendCdpCommand = (command: Record<string, unknown>) => {
        debugMessageEmitter.emit("proxymessage", JSON.stringify(command));
    };

    const injectWxAppServiceProbeScript = (
        executionContextId: number,
        frameId: string | null,
        sessionId: string | null,
    ) => {
        const dedupeKey = `${sessionId ?? "root"}:${executionContextId}`;
        if (probeScriptInjectedContexts.has(dedupeKey)) {
            return;
        }

        probeScriptInjectedContexts.add(dedupeKey);
        const id = nextProbeScriptInjectionId++;
        pendingProbeScriptInjectionResults.set(id, {
            executionContextId,
            frameId,
            sessionId,
        });

        const command: Record<string, unknown> = {
            id,
            method: "Runtime.evaluate",
            params: {
                expression: APPSERVICE_CONTEXT_PROBE_EXPRESSION,
                contextId: executionContextId,
                returnByValue: true,
                silent: true,
            },
        };

        if (sessionId) {
            command.sessionId = sessionId;
        }

        sendCdpCommand(command);
    };

    const injectInitScript = (
        executionContextId: number,
        frameId: string | null,
        sessionId: string | null,
    ) => {
        const dedupeKey = `${sessionId ?? "root"}:${executionContextId}`;
        if (initScriptInjectedContexts.has(dedupeKey)) {
            return;
        }

        initScriptInjectedContexts.add(dedupeKey);
        const id = nextInitScriptInjectionId++;
        pendingInitScriptInjectionResults.set(id, {
            executionContextId,
            frameId,
            sessionId,
        });

        const command: Record<string, unknown> = {
            id,
            method: "Runtime.evaluate",
            params: {
                expression: initScriptSource,
                contextId: executionContextId,
                includeCommandLineAPI: true,
                awaitPromise: false,
                returnByValue: true,
            },
        };

        if (sessionId) {
            command.sessionId = sessionId;
        }

        sendCdpCommand(command);
    };

    const resetContextSelection = () => {
        nextProbeScriptInjectionId = 100_000;
        nextInitScriptInjectionId = 200_000;
        pendingProbeScriptInjectionResults.clear();
        pendingInitScriptInjectionResults.clear();
        probeScriptInjectedContexts.clear();
        initScriptInjectedContexts.clear();
        candidate = null;
    };

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
            const parsedPayload = tryParseJson(unwrappedData.data.payload);
            const toCheckProbeResult =
                parsedPayload && typeof parsedPayload.id === "number"
                    ? pendingProbeScriptInjectionResults.get(parsedPayload.id)
                    : undefined;
            const toCheckInitScriptInjectionResult =
                parsedPayload && typeof parsedPayload.id === "number"
                    ? pendingInitScriptInjectionResults.get(parsedPayload.id)
                    : undefined;

            if (toCheckProbeResult) {
                pendingProbeScriptInjectionResults.delete(parsedPayload.id);
                const probeValue = parsedPayload.result?.result?.value ?? null;

                if (
                    candidate === null &&
                    probeValue &&
                    typeof probeValue === "object" &&
                    probeValue.ok === true &&
                    probeValue.hasLocation === false &&
                    probeValue.hasWx === true &&
                    probeValue.hasRequire === true
                ) {
                    candidate = {
                        executionContextId:
                            toCheckProbeResult.executionContextId,
                        frameId: toCheckProbeResult.frameId,
                        sessionId: toCheckProbeResult.sessionId,
                    };
                    logger.info("[miniapp] identified wechat app-service candidate", {
                        sessionId: candidate.sessionId,
                        executionContextId:
                            candidate.executionContextId,
                        frameId: candidate.frameId,
                    });
                    injectInitScript(
                        candidate.executionContextId,
                        candidate.frameId,
                        candidate.sessionId,
                    );
                }
            }

            if (toCheckInitScriptInjectionResult) {
                pendingInitScriptInjectionResults.delete(parsedPayload.id);
                const exceptionDetails =
                    parsedPayload.result?.exceptionDetails ?? null;
                
                logger.info("[miniapp] init-script injection result", {
                    sessionId: toCheckInitScriptInjectionResult.sessionId,
                    executionContextId:
                        toCheckInitScriptInjectionResult.executionContextId,
                    frameId: toCheckInitScriptInjectionResult.frameId,
                    success: exceptionDetails === null,
                    exceptionDetails,
                });
            }


            const context = parsedPayload?.params?.context;
            if (
                parsedPayload?.method === "Runtime.executionContextCreated" &&
                (parsedPayload.sessionId === undefined || parsedPayload.sessionId === null) &&
                context?.origin === "https://servicewechat.com" &&
                context?.auxData?.type === "default"
            ) {
                logger.info("[miniapp] need to inject probe script", {
                    method: parsedPayload?.method,
                    sessionId: parsedPayload?.sessionId,
                    contextOrigin: context?.origin,
                    contextAuxDataType: context?.auxData?.type,
                });
                injectWxAppServiceProbeScript(
                    parsedPayload.params.context.id,
                    parsedPayload.params.context.auxData?.frameId ?? null,
                    parsedPayload.sessionId ?? null,
                );
            }

            // need to proxy to CDP client
            debugMessageEmitter.emit("cdpmessage", unwrappedData.data.payload);
        }
    };

    wss.on("connection", (ws: WebSocket) => {
        resetContextSelection();
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
    logger.info(
        `[server] proxy server running on ws://localhost:${options.cdpPort}`,
    );
    logger.info(
        `[server] link: devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${options.cdpPort}`,
    );

    const onMessage = (message: string) => {
        debugMessageEmitter.emit("proxymessage", message);
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
                    // send CDP message to devtools
                    client.send(message);
                }
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
    const projectRoot = getProjectRoot();
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

const getProjectRoot = () =>
    path.join(
        path.dirname(
            (require.main && require.main.filename) ||
                (process.mainModule && process.mainModule.filename) ||
                process.cwd(),
        ),
        "..",
    );

const load_init_script_source = async (options: CliOptions) => {
    const projectRoot = getProjectRoot();

    try {
        return (
            await promises.readFile(path.join(projectRoot, options.initScript))
        ).toString();
    } catch {
        throw new Error(
            `[main] init script not found: ${options.initScript}`,
        );
    }
};

const main = async () => {
    const options = parse_cli_options();
    const logger = create_logger(options);
    const initScriptSource = await load_init_script_source(options);
    debug_server(options, logger, initScriptSource);
    proxy_server(options, logger);
    frida_server(options, logger);
};

(async () => {
    await main();
})();
