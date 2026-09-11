import { IPlatform, WmpfProcessInfo } from "./types";
import * as frida from "frida"
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function searchWmpfVersionInFile(filePath: string): number {
    const buffer = fs.readFileSync(filePath);
    const binstr = buffer.toString('latin1');
    const regex = /,(?:\d+\.){3}(\d+)\x00/;
    const match = regex.exec(binstr);
    return match && match[1]
        ? Number(match[1])
        : 0;
}

/**
 * Read the --client_version argument from the process command line
 * (e.g. "--client_version=4067695881"). Works inside flatpak/bwrap since we
 * access /proc/<pid>/cmdline directly.
 */
function searchClientVersionInCmdline(pid: number): number {
    try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "latin1");
        const match = /--client_version=(\d+)/.exec(cmdline.replace(/\x00/g, " "));
        return match && match[1] ? Number(match[1]) : 0;
    } catch {
        return 0;
    }
}

/**
 * Resolve the executable path reported by frida to a path accessible on the
 * host filesystem. When the target process runs inside a sandbox (e.g. the
 * flatpak com.tencent.WeChat), frida reports the path as seen from inside the
 * sandbox (e.g. /app/extra/wechat/...), which does not exist on the host.
 *
 * Resolution order:
 *  1. Use the path as-is (native installation).
 *  2. Access it through /proc/<pid>/root, which points to the filesystem root
 *     of the sandboxed process (works for flatpak/bwrap namespaces).
 *  3. Map the flatpak /app prefix onto the app files directory of any
 *     installed flatpak (user or system), i.e.
 *     <flatpak>/app/<app-id>/current/active/files/...
 */
function resolveHostPath(pid: number, sandboxPath: string): string | null {
    if (fs.existsSync(sandboxPath)) {
        return sandboxPath;
    }

    const procRootPath = path.join("/proc", String(pid), "root", sandboxPath);
    if (fs.existsSync(procRootPath)) {
        return procRootPath;
    }

    if (sandboxPath.startsWith("/app/")) {
        const relativePath = sandboxPath.slice("/app/".length);
        const flatpakAppRoots = [
            path.join(os.homedir(), ".local/share/flatpak/app"),
            "/var/lib/flatpak/app",
        ];
        for (const flatpakAppRoot of flatpakAppRoots) {
            if (!fs.existsSync(flatpakAppRoot)) {
                continue;
            }
            for (const appId of fs.readdirSync(flatpakAppRoot)) {
                const candidate = path.join(
                    flatpakAppRoot,
                    appId,
                    "current/active/files",
                    relativePath,
                );
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }
    }

    return null;
}

export class LinuxPlatform implements IPlatform {
    async findWmpfProcess(): Promise<WmpfProcessInfo> {
        const localDevice = await frida.getLocalDevice();
        const processes = await localDevice.enumerateProcesses({
            scope: frida.Scope.Metadata,
        });
        const wmpfProcesses = processes.filter(
            (process) => process.name === "WeChatAppEx",
        );
        if (wmpfProcesses.length === 0) {
            throw new Error("[frida] WeChatAppEx process not found");
        }

        // Select the root WeChatAppEx process: the one whose parent is not
        // itself a WeChatAppEx process. Newer builds spawn zygote/renderer/
        // gpu/utility children whose ppid points at intermediate nodes, so a
        // frequency heuristic on ppids may pick the wrong process.
        const wmpfPids = new Set(wmpfProcesses.map((p) => p.pid));
        const wmpfProcess = wmpfProcesses.find((p) => {
            const ppid = p.parameters.ppid ? Number(p.parameters.ppid) : 0;
            return ppid !== 0 && !wmpfPids.has(ppid);
        });
        if (wmpfProcess === undefined) {
            throw new Error("[frida] WeChatAppEx root process not found");
        }
        const wmpfPid = Number(wmpfProcess.pid);
        const wmpfProcessPath = wmpfProcess.parameters.path as
            | string
            | undefined;
        const hostPath =
            wmpfProcessPath && wmpfPid !== 0
                ? resolveHostPath(wmpfPid, wmpfProcessPath)
                : null;

        // Version detection:
        //  1. WMPF <= 14978 embeds a ",x.y.z.<version>" literal; find it.
        //  2. Newer builds (WeChat 4.1.13+) dropped that literal; fall back to
        //     the --client_version command line argument (see issue #167).
        let wmpfVersion =
            hostPath !== null ? searchWmpfVersionInFile(hostPath) : 0;
        if (wmpfVersion === 0) {
            wmpfVersion = searchClientVersionInCmdline(wmpfPid);
        }
        if (wmpfVersion === 0) {
            throw new Error(
                `[frida] error in find wmpf version (process path: ${hostPath ?? wmpfProcessPath})`,
            );
        }
        return { pid: wmpfPid, version: wmpfVersion };
    }
}
