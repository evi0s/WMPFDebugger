import { EventEmitter } from "node:events";

type JsonObject = Record<string, any>;

type CdpTargetInfo = {
    targetId: string;
    type?: string;
    title?: string;
    url?: string;
};

type LoggerLike = {
    info: (...args: any[]) => void;
    error: (...args: any[]) => void;
    main_debug: (...args: any[]) => void;
};

type CdpRouterOptions = {
    h5Url: string | null;
    discoveryIntervalMs?: number;
    discoveryTimeoutMs?: number;
};

type PendingInternalRequest = {
    kind: "getTargets" | "attach";
    startedAt: number;
    targetId?: string;
    timer: ReturnType<typeof setTimeout>;
};

type QueuedDevtoolsMessage = {
    id: number | string | null;
    message: JsonObject;
};

const TOP_LEVEL_METHOD_PREFIXES = ["Target.", "Browser.", "SystemInfo."];

class CdpRouter extends EventEmitter {
    private readonly h5Url: string | null;
    private readonly logger: LoggerLike;
    private readonly discoveryIntervalMs: number;
    private readonly discoveryTimeoutMs: number;
    private readonly pendingInternalRequests = new Map<number, PendingInternalRequest>();
    private readonly queuedDevtoolsMessages: QueuedDevtoolsMessage[] = [];
    private readonly topLevelDevtoolsRequestIds = new Set<number | string>();
    private internalRequestId = 900000000;
    private activeSessionId: string | null = null;
    private activeTargetId: string | null = null;
    private discoveryStartedAt = 0;
    private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
    private hasLoggedDiscoveryStart = false;
    private lastVisibleTargets: CdpTargetInfo[] = [];
    private terminalAttachFailureMessage: string | null = null;
    private disposed = false;

    constructor(options: CdpRouterOptions, logger: LoggerLike) {
        super();
        this.h5Url = options.h5Url;
        this.logger = logger;
        this.discoveryIntervalMs = options.discoveryIntervalMs ?? 500;
        this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? 15000;
    }

    isH5Mode() {
        return this.h5Url !== null;
    }

    start() {
        if (this.disposed) {
            return;
        }

        if (!this.isH5Mode()) {
            return;
        }

        this.terminalAttachFailureMessage = null;
        this.discoveryStartedAt = Date.now();
        this.scheduleDiscovery(0);
    }

    dispose() {
        this.disposed = true;
        if (this.discoveryTimer !== null) {
            clearTimeout(this.discoveryTimer);
            this.discoveryTimer = null;
        }
        this.clearPendingInternalRequests();
    }

    handleDevtoolsMessage(rawMessage: string) {
        if (this.disposed) {
            return;
        }

        if (!this.isH5Mode()) {
            this.emit("wechat", rawMessage);
            return;
        }

        const message = this.parseJson(rawMessage, "devtools");
        if (message === null) {
            return;
        }

        if (this.activeSessionId === null) {
            if (this.terminalAttachFailureMessage !== null) {
                if (this.shouldStayTopLevel(message)) {
                    this.forwardDevtoolsMessage(message);
                    return;
                }

                this.failDevtoolsMessage(message, this.terminalAttachFailureMessage);
                return;
            }

            this.queueDevtoolsMessage(message);
            return;
        }

        this.forwardDevtoolsMessage(message);
    }

    handleWechatMessage(rawMessage: string) {
        if (this.disposed) {
            return;
        }

        if (!this.isH5Mode()) {
            this.emit("devtools", rawMessage);
            return;
        }

        const message = this.parseJson(rawMessage, "wechat");
        if (message === null) {
            return;
        }

        if (message.sessionId !== undefined) {
            if (message.sessionId === this.activeSessionId) {
                const { sessionId, ...pageMessage } = message;
                this.emitToDevtools(pageMessage);
            }
            return;
        }

        if (typeof message.id === "number" && this.pendingInternalRequests.has(message.id)) {
            this.handleInternalResponse(message.id, message);
            return;
        }

        if (message.id !== undefined && this.topLevelDevtoolsRequestIds.has(message.id)) {
            this.topLevelDevtoolsRequestIds.delete(message.id);
            this.emitToDevtools(message);
            return;
        }

        if (typeof message.method === "string" && message.method.startsWith("Target.")) {
            this.handleTargetLifecycleEvent(message);
            this.logger.main_debug("[h5] top-level target event", message);
            this.emitToDevtools(message);
        }
    }

    private emitToWechat(message: JsonObject) {
        if (this.disposed) {
            return;
        }

        this.emit("wechat", JSON.stringify(message));
    }

    private emitToDevtools(message: JsonObject) {
        if (this.disposed) {
            return;
        }

        this.emit("devtools", JSON.stringify(message));
    }

    private nextInternalId() {
        this.internalRequestId += 1;
        return this.internalRequestId;
    }

    private sendInternalRequest(kind: PendingInternalRequest["kind"], method: string, params?: JsonObject) {
        if (this.disposed) {
            return;
        }

        const id = this.nextInternalId();
        this.pendingInternalRequests.set(id, {
            kind,
            startedAt: Date.now(),
            targetId: typeof params?.targetId === "string" ? params.targetId : undefined,
            timer: setTimeout(() => {
                if (this.disposed) {
                    return;
                }

                this.handleInternalRequestTimeout(id);
            }, this.getInternalRequestTimeoutMs()),
        });
        this.emitToWechat({
            id,
            method,
            ...(params === undefined ? {} : { params }),
        });
        return id;
    }

    private scheduleDiscovery(delayMs: number) {
        if (this.disposed || !this.isH5Mode() || this.activeSessionId !== null) {
            return;
        }

        if (this.hasDiscoveryTimedOut()) {
            this.logger.error(
                `[h5] target not found for URL keyword: ${this.h5Url}`,
            );
            this.logVisibleTargets();
            this.failTerminalAttach("H5 target was not attached: matching URL was not found");
            return;
        }

        if (this.discoveryTimer !== null) {
            clearTimeout(this.discoveryTimer);
        }

        this.discoveryTimer = setTimeout(() => {
            if (this.disposed) {
                return;
            }

            this.discoveryTimer = null;
            this.discoverTargets();
        }, delayMs);
    }

    private discoverTargets() {
        if (this.disposed || !this.isH5Mode() || this.activeSessionId !== null) {
            return;
        }

        if (this.hasDiscoveryTimedOut()) {
            this.logger.error(
                `[h5] target not found for URL keyword: ${this.h5Url}`,
            );
            this.logVisibleTargets();
            this.failTerminalAttach("H5 target was not attached: matching URL was not found");
            return;
        }

        if (!this.hasLoggedDiscoveryStart) {
            this.logger.info(`[h5] searching target by URL keyword: ${this.h5Url}`);
            this.hasLoggedDiscoveryStart = true;
        }

        this.sendInternalRequest("getTargets", "Target.getTargets");
    }

    private forwardDevtoolsMessage(message: JsonObject) {
        if (this.shouldStayTopLevel(message)) {
            if (message.id !== undefined) {
                this.topLevelDevtoolsRequestIds.add(message.id);
            }
            this.emitToWechat(message);
            return;
        }

        this.emitToWechat({
            ...message,
            sessionId: this.activeSessionId,
        });
    }

    private shouldStayTopLevel(message: JsonObject) {
        return (
            typeof message.method === "string" &&
            TOP_LEVEL_METHOD_PREFIXES.some((prefix) => message.method.startsWith(prefix))
        );
    }

    private queueDevtoolsMessage(message: JsonObject) {
        this.queuedDevtoolsMessages.push({
            id: message.id ?? null,
            message,
        });
    }

    private handleInternalResponse(id: number, message: JsonObject) {
        const pendingRequest = this.pendingInternalRequests.get(id);
        this.pendingInternalRequests.delete(id);
        if (pendingRequest === undefined) {
            return;
        }
        clearTimeout(pendingRequest.timer);

        if (message.error !== undefined) {
            if (pendingRequest.kind === "attach") {
                this.logger.error(`[h5] attach failed for target ${pendingRequest.targetId ?? "unknown"}:`, message.error);
            } else {
                this.logger.error(`[h5] ${pendingRequest.kind} failed:`, message.error);
            }
            if (pendingRequest.kind === "getTargets") {
                this.scheduleDiscovery(this.discoveryIntervalMs);
            } else {
                this.handleAttachFailure("H5 target was not attached: attach failed");
            }
            return;
        }

        if (pendingRequest.kind === "getTargets") {
            this.handleGetTargetsResult(message);
            return;
        }

        if (pendingRequest.kind === "attach") {
            this.handleAttachResult(message, pendingRequest);
        }
    }

    private handleGetTargetsResult(message: JsonObject) {
        const targetInfos = this.getTargetInfos(message);
        this.lastVisibleTargets = targetInfos;
        const matchedTarget = targetInfos.find((targetInfo) =>
            typeof targetInfo.url === "string" && targetInfo.url.includes(this.h5Url as string),
        );

        if (matchedTarget === undefined) {
            this.scheduleDiscovery(this.discoveryIntervalMs);
            return;
        }

        this.logger.info(
            `[h5] matched target: ${matchedTarget.targetId} ${matchedTarget.url ?? ""} ${matchedTarget.title ?? ""}`.trim(),
        );
        this.sendInternalRequest("attach", "Target.attachToTarget", {
            targetId: matchedTarget.targetId,
            flatten: true,
        });
    }

    private handleAttachResult(message: JsonObject, pendingRequest: PendingInternalRequest) {
        const sessionId = message.result?.sessionId;
        if (typeof sessionId !== "string" || sessionId.length === 0) {
            this.logger.error(`[h5] attach failed for target ${pendingRequest.targetId ?? "unknown"}: missing sessionId`, message);
            this.handleAttachFailure("H5 target was not attached: attach response had no sessionId");
            return;
        }

        this.activeSessionId = sessionId;
        this.activeTargetId = pendingRequest.targetId ?? null;
        this.logger.info(`[h5] attached target session: ${sessionId}`);
        this.flushQueuedDevtoolsMessages();
    }

    private handleTargetLifecycleEvent(message: JsonObject) {
        if (message.method === "Target.detachedFromTarget") {
            const detachedSessionId = message.params?.sessionId;
            if (detachedSessionId === this.activeSessionId) {
                this.logger.info(`[h5] attached target detached: ${detachedSessionId}`);
                this.restartDiscovery();
            }
            return;
        }

        if (message.method === "Target.targetDestroyed") {
            const destroyedTargetId = message.params?.targetId;
            if (destroyedTargetId === this.activeTargetId) {
                this.logger.info(`[h5] attached target destroyed: ${destroyedTargetId}`);
                this.restartDiscovery();
            }
        }
    }

    private restartDiscovery() {
        if (this.disposed) {
            return;
        }

        this.clearPendingInternalRequests();
        this.activeSessionId = null;
        this.activeTargetId = null;
        this.terminalAttachFailureMessage = null;
        this.discoveryStartedAt = Date.now();
        this.hasLoggedDiscoveryStart = false;
        this.scheduleDiscovery(0);
    }

    private handleInternalRequestTimeout(id: number) {
        if (this.disposed) {
            return;
        }

        const pendingRequest = this.pendingInternalRequests.get(id);
        if (pendingRequest === undefined) {
            return;
        }

        this.pendingInternalRequests.delete(id);
        if (pendingRequest.kind === "attach") {
            this.logger.error(
                `[h5] attach timed out for target ${pendingRequest.targetId ?? "unknown"} after ${Date.now() - pendingRequest.startedAt}ms`,
            );
        } else {
            this.logger.error(`[h5] ${pendingRequest.kind} timed out after ${Date.now() - pendingRequest.startedAt}ms`);
        }

        if (pendingRequest.kind === "getTargets") {
            if (this.hasDiscoveryTimedOut()) {
                this.logger.error(
                    `[h5] target not found for URL keyword: ${this.h5Url}`,
                );
                this.logVisibleTargets();
                this.failTerminalAttach("H5 target was not attached: matching URL was not found");
                return;
            }

            this.scheduleDiscovery(this.discoveryIntervalMs);
            return;
        }

        this.handleAttachFailure("H5 target was not attached: attach timed out");
    }

    private handleAttachFailure(message: string) {
        this.failQueuedDevtoolsMessages(message);
        this.activeSessionId = null;
        this.activeTargetId = null;

        if (this.hasDiscoveryTimedOut()) {
            this.logger.error(
                `[h5] target not found for URL keyword: ${this.h5Url}`,
            );
            this.logVisibleTargets();
            this.terminalAttachFailureMessage = message;
            return;
        }

        this.scheduleDiscovery(this.discoveryIntervalMs);
    }

    private getInternalRequestTimeoutMs() {
        const remainingDiscoveryMs = this.discoveryTimeoutMs - (Date.now() - this.discoveryStartedAt);
        return Math.max(1, Math.min(this.discoveryIntervalMs, remainingDiscoveryMs));
    }

    private hasDiscoveryTimedOut() {
        return Date.now() - this.discoveryStartedAt > this.discoveryTimeoutMs;
    }

    private clearPendingInternalRequests() {
        this.pendingInternalRequests.forEach((pendingRequest) => {
            clearTimeout(pendingRequest.timer);
        });
        this.pendingInternalRequests.clear();
    }

    private parseJson(rawMessage: string, source: string) {
        try {
            const parsed = JSON.parse(rawMessage);
            if (!this.isJsonObject(parsed)) {
                this.logger.error(`[h5] invalid CDP JSON from ${source}: expected object`);
                return null;
            }

            return parsed;
        } catch (e) {
            this.logger.error(`[h5] invalid CDP JSON from ${source}:`, e);
            return null;
        }
    }

    private isJsonObject(value: unknown): value is JsonObject {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    private getTargetInfos(message: JsonObject): CdpTargetInfo[] {
        const targetInfos = message.result?.targetInfos;
        if (!Array.isArray(targetInfos)) {
            return [];
        }

        return targetInfos.filter((targetInfo): targetInfo is CdpTargetInfo => {
            return typeof targetInfo === "object" && targetInfo !== null && typeof targetInfo.targetId === "string";
        });
    }

    private flushQueuedDevtoolsMessages() {
        const queuedMessages = this.queuedDevtoolsMessages.splice(0);
        queuedMessages.forEach((queuedMessage) => {
            this.forwardDevtoolsMessage(queuedMessage.message);
        });
    }

    private failQueuedDevtoolsMessages(message: string) {
        const queuedMessages = this.queuedDevtoolsMessages.splice(0);
        queuedMessages.forEach((queuedMessage) => {
            if (queuedMessage.id === null) {
                return;
            }

            this.failDevtoolsRequest(queuedMessage.id, message);
        });
    }

    private failTerminalAttach(message: string) {
        this.terminalAttachFailureMessage = message;
        this.failQueuedDevtoolsMessages(message);
    }

    private failDevtoolsMessage(message: JsonObject, errorMessage: string) {
        if (message.id === undefined || message.id === null) {
            return;
        }

        this.failDevtoolsRequest(message.id, errorMessage);
    }

    private failDevtoolsRequest(id: number | string, message: string) {
        this.emitToDevtools({
            id,
            error: {
                code: -32000,
                message,
            },
        });
    }

    private logVisibleTargets() {
        const visibleTargets = this.lastVisibleTargets.map((targetInfo) => ({
            targetId: targetInfo.targetId,
            type: targetInfo.type ?? "",
            title: targetInfo.title ?? "",
            url: targetInfo.url ?? "",
        }));
        this.logger.error("[h5] visible targets:", visibleTargets);
    }
}

export { CdpRouter, CdpRouterOptions };
