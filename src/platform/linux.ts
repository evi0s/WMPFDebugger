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

        const allWmpf = processes.filter(p => p.name === "WeChatAppEx");
        for (const proc of allWmpf) {
            const ppid = proc.parameters.ppid;
            if (!ppid) continue;
            const parent = processes.find(p => p.pid === ppid);
            if (parent && parent.name !== "WeChatAppEx") {
                const wmpfProcessPath = proc.parameters.path as string | undefined;
                const wmpfVersion = wmpfProcessPath
                    ? searchWmpfVersionInFile(wmpfProcessPath)
                    : 0;
                if (wmpfVersion === 0) {
                    throw new Error("[frida] error in find wmpf version");
                }
                return { pid: proc.pid, version: wmpfVersion };
            }
        }

        throw new Error("[frida] WeChatAppEx root process not found");
    }
}
