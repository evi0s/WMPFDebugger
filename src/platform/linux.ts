import { IPlatform, WmpfProcessInfo } from "./types";
import * as frida from "frida"
import * as fs from 'fs';

function searchWmpfVersionInFile(filePath: string): number {
    const buffer = fs.readFileSync(filePath);
    const binstr = buffer.toString('latin1');
    const regex = /,(?:\d+\.){3}(\d+)\x00/;
    const match = regex.exec(binstr);
    return match && match[1]
        ? Number(match[1])
        : 0;
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
            throw new Error("[frida] WeChatAppEx process not found");
        }
        const wmpfProcess = processes.filter(
            (process) => process.pid === wmpfPid,
        )[0];
        const wmpfProcessPath = wmpfProcess.parameters.path as string | undefined;
        const wmpfVersion = wmpfProcessPath
            ? searchWmpfVersionInFile(wmpfProcessPath)
            : 0;
        if (wmpfVersion === 0) {
            throw new Error("[frida] error in find wmpf version");
        }
        return { pid: Number(wmpfPid), version: wmpfVersion };
    }
}
