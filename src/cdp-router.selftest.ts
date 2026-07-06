import { CdpRouter } from "./cdp-router";

type CapturedLog = { level: string; args: any[] };

const createLogger = () => {
    const logs: CapturedLog[] = [];
    return {
        logs,
        logger: {
            info: (...args: any[]) => logs.push({ level: "info", args }),
            error: (...args: any[]) => logs.push({ level: "error", args }),
            main_debug: (...args: any[]) => logs.push({ level: "debug", args }),
        },
    };
};

const collectRouterOutput = (router: CdpRouter) => {
    const wechat: string[] = [];
    const devtools: string[] = [];
    router.on("wechat", (message) => wechat.push(message));
    router.on("devtools", (message) => devtools.push(message));
    return { wechat, devtools };
};

const parse = (message: string) => JSON.parse(message);

const parsedMessages = (messages: string[]) => messages.map(parse);

const findMessage = (messages: string[], predicate: (message: any) => boolean) =>
    parsedMessages(messages).find(predicate);

const messagesByMethod = (messages: string[], method: string) =>
    parsedMessages(messages).filter((message) => message.method === method);

const assert = (condition: unknown, message: string) => {
    if (!condition) {
        throw new Error(message);
    }
};

const assertDeepEqual = (actual: unknown, expected: unknown, message: string) => {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    if (actualJson !== expectedJson) {
        throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
    }
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition: () => boolean, message: string, timeoutMs = 100) => {
    const startedAt = Date.now();
    while (!condition()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error(message);
        }
        await delay(1);
    }
};

const testTransparentMode = () => {
    const { logger } = createLogger();
    const router = new CdpRouter({ h5Url: null }, logger);
    const output = collectRouterOutput(router);

    try {
        const devtoolsMessage = JSON.stringify({ id: 1, method: "Runtime.enable" });
        const wechatMessage = JSON.stringify({ id: 1, result: {} });
        router.handleDevtoolsMessage(devtoolsMessage);
        router.handleWechatMessage(wechatMessage);

        assert(output.wechat.length === 1, "transparent mode forwards DevTools to WeChat");
        assert(output.devtools.length === 1, "transparent mode forwards WeChat to DevTools");
        assert(output.wechat[0] === devtoolsMessage, "transparent mode preserves DevTools message unchanged");
        assert(output.devtools[0] === wechatMessage, "transparent mode preserves WeChat message unchanged");
    } finally {
        router.dispose();
    }
};

const testH5DiscoveryAttachAndRouting = async () => {
    const { logger } = createLogger();
    const router = new CdpRouter(
        { h5Url: "mp.weixin.qq.com", discoveryIntervalMs: 100, discoveryTimeoutMs: 1000 },
        logger,
    );
    const output = collectRouterOutput(router);

    try {
        router.start();
        router.handleDevtoolsMessage(JSON.stringify({ id: 7, method: "Runtime.enable" }));

        await waitFor(
            () => findMessage(output.wechat, (message) => message.method === "Target.getTargets") !== undefined,
            "router sends Target.getTargets on start",
        );
        const getTargets = findMessage(output.wechat, (message) => message.method === "Target.getTargets");
        assert(getTargets !== undefined, "first internal request is Target.getTargets");

        router.handleWechatMessage(
            JSON.stringify({
                id: getTargets.id,
                result: {
                    targetInfos: [
                        { targetId: "miniapp", type: "page", title: "AppIndex", url: "appservice://index" },
                        { targetId: "h5", type: "page", title: "Official Account", url: "https://mp.weixin.qq.com/s/demo" },
                    ],
                },
            }),
        );

        await waitFor(
            () => findMessage(output.wechat, (message) => message.method === "Target.attachToTarget") !== undefined,
            "router sends attach request after target match",
        );
        const attach = findMessage(output.wechat, (message) => message.method === "Target.attachToTarget");
        assert(attach !== undefined, "second internal request is attach");
        assert(attach.params.targetId === "h5", "attach uses matched target id");
        assert(attach.params.flatten === true, "attach uses flattened sessions");
        assert(
            findMessage(output.wechat, (message) => message.id === 7 && message.method === "Runtime.enable") === undefined,
            "queued Runtime.enable is not forwarded before attach succeeds",
        );

        router.handleWechatMessage(
            JSON.stringify({
                id: attach.id,
                result: { sessionId: "session-h5" },
            }),
        );

        await waitFor(
            () => findMessage(output.wechat, (message) => message.id === 7 && message.sessionId === "session-h5") !== undefined,
            "router flushes queued DevTools request after attach",
        );
        const flushed = findMessage(output.wechat, (message) => message.id === 7 && message.sessionId === "session-h5");
        assert(flushed !== undefined, "flushed request is emitted");
        assert(flushed.method === "Runtime.enable", "flushed request preserves method");

        const resultPayload = { result: { type: "number", value: 42, description: "42" } };
        router.handleWechatMessage(
            JSON.stringify({
                id: 7,
                sessionId: "session-h5",
                result: resultPayload,
            }),
        );

        assert(output.devtools.length === 1, "router forwards active session response to DevTools");
        const response = parse(output.devtools[0]);
        assertDeepEqual(
            response,
            { id: 7, result: resultPayload },
            "response preserves full payload and removes session id",
        );

        const topLevelWechatCountBefore = output.wechat.length;
        router.handleDevtoolsMessage(JSON.stringify({ id: 8, method: "Browser.getVersion" }));
        assert(
            output.wechat.length === topLevelWechatCountBefore + 1,
            "Browser.getVersion forwards to WeChat after attach",
        );
        const browserGetVersion = parse(output.wechat[output.wechat.length - 1]);
        assert(browserGetVersion.id === 8, "Browser.getVersion preserves request id");
        assert(browserGetVersion.method === "Browser.getVersion", "Browser.getVersion preserves method");
        assert(browserGetVersion.sessionId === undefined, "Browser.getVersion stays top-level (no sessionId)");
    } finally {
        router.dispose();
    }
};

const testDiscoveryTimeoutFailsQueuedAndLaterRequests = async () => {
    const { logger } = createLogger();
    const router = new CdpRouter(
        { h5Url: "missing.example", discoveryIntervalMs: 20, discoveryTimeoutMs: 80 },
        logger,
    );
    const output = collectRouterOutput(router);

    try {
        router.start();
        router.handleDevtoolsMessage(JSON.stringify({ id: 11, method: "Runtime.enable" }));

        await waitFor(() => messagesByMethod(output.wechat, "Target.getTargets").length >= 1, "router sends getTargets before timeout");
        const firstGetTargets = messagesByMethod(output.wechat, "Target.getTargets")[0];
        router.handleWechatMessage(
            JSON.stringify({
                id: firstGetTargets.id,
                result: { targetInfos: [] },
            }),
        );

        await waitFor(
            () => messagesByMethod(output.wechat, "Target.getTargets").length >= 2,
            "router retries Target.getTargets after no matching target",
            150,
        );
        assert(
            messagesByMethod(output.wechat, "Target.getTargets").length >= 2,
            "timeout path proves at least one discovery retry",
        );

        await waitFor(() => output.devtools.length === 1, "timeout replies to queued DevTools request", 200);
        const queuedError = parse(output.devtools[0]);
        assert(queuedError.id === 11, "timeout error preserves queued request id");
        assert(queuedError.error.code === -32000, "timeout error uses JSON-RPC -32000");
        assert(
            queuedError.error.message.includes("H5 target was not attached"),
            "timeout error explains attach failure",
        );

        const wechatCountAfterFailure = output.wechat.length;
        router.handleDevtoolsMessage(JSON.stringify({ id: 12, method: "Runtime.evaluate", params: { expression: "1" } }));

        assert(output.devtools.length === 2, "later DevTools request fails immediately after terminal failure");
        const laterError = parse(output.devtools[1]);
        assert(laterError.id === 12, "later error preserves request id");
        assert(laterError.error.code === -32000, "later error uses JSON-RPC -32000");
        assert(output.wechat.length === wechatCountAfterFailure, "later failed request is not queued or forwarded");

        router.handleDevtoolsMessage(JSON.stringify({ method: "Runtime.consoleAPICalled", params: { type: "log" } }));
        assert(output.wechat.length === wechatCountAfterFailure, "later notification without id is dropped after terminal failure");

        router.handleDevtoolsMessage(JSON.stringify({ id: 13, method: "Target.getTargets" }));
        assert(output.wechat.length === wechatCountAfterFailure + 1, "later Target.getTargets is forwarded after terminal failure");
        const manualGetTargets = parse(output.wechat[output.wechat.length - 1]);
        assert(manualGetTargets.id === 13, "manual Target.getTargets preserves request id");
        assert(manualGetTargets.method === "Target.getTargets", "manual Target.getTargets preserves method");
        assert(manualGetTargets.sessionId === undefined, "manual Target.getTargets remains top-level");
    } finally {
        router.dispose();
    }
};

const main = async () => {
    testTransparentMode();
    await testH5DiscoveryAttachAndRouting();
    await testDiscoveryTimeoutFailsQueuedAndLaterRequests();
    console.log("cdp-router selftest passed");
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
