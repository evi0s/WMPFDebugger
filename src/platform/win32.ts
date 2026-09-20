import { IPlatform, WmpfProcessInfo } from "./types";
import * as frida from "frida"

export class WindowsPlatform implements IPlatform {
    async findWmpfProcess(): Promise<WmpfProcessInfo> {
        const localDevice = await frida.getLocalDevice();
        const processes = await localDevice.enumerateProcesses({
            scope: frida.Scope.Metadata,
        });
        const wmpfProcesses = processes.filter(
            (process) => process.name === "WeChatAppEx.exe",
        );
        const wmpfPids = wmpfProcesses.map((p) =>
            p.parameters.ppid !== undefined
                ? Number(p.parameters.ppid)
                : 0,
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
        }
        const wmpfProcess = processes.find(
            (process) => process.pid === wmpfPid,
        );
        if (wmpfProcess === undefined) {
            throw new Error("[frida] wmpf browser process not found");
        }
        const wmpfProcessArgv = wmpfProcess.parameters.argv as Array<string>;
        const flueRuntimeDir = wmpfProcessArgv.find(e => e.startsWith("--flue-runtime-dir"));
        // legacy wmpf path fall back
        const matchPath = flueRuntimeDir ? flueRuntimeDir : wmpfProcess.parameters.path as string | undefined;
        const wmpfVersionMatch = matchPath
            ? matchPath.match(/\d+/g)
            : "";
        const wmpfVersion = wmpfVersionMatch
            ? Number(wmpfVersionMatch.pop())
            : 0;
        if (wmpfVersion === 0) {
            throw new Error("[frida] error in find wmpf version");
        }
        return { pid: Number(wmpfPid), version: wmpfVersion }
    }
}
