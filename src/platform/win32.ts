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
        }
        const wmpfProcess = processes.filter(
            (process) => process.pid === wmpfPid,
        )[0];
        const wmpfProcessPath = wmpfProcess.parameters.path as string | undefined;
        const wmpfVersionMatch = wmpfProcessPath
            ? wmpfProcessPath.match(/\d+/g)
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
