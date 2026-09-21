import { IPlatform, WmpfProcessInfo } from "./types";
import * as frida from "frida"
import * as fs from 'fs';

function searchWmpfVersionInFile(filePath: string): number {
    const buffer = fs.readFileSync(filePath);
    const binstr = buffer.toString('latin1');
    const regex = /wmpf_release\/([^\0]+)\0/; // wmpf_release/xwechat_2026T6_2.5.6
    const match = regex.exec(binstr); // xwechat_2026T6_2.5.6
    if (match && match[1]) {
        const mainVersion = match[1].split("_").pop()! // 2.5.6
        const subRegex = new RegExp(`${mainVersion.replaceAll(".", "\\.")}\\.([^\0]+)\0`) // 2.5.6.25665
        const subMatch = subRegex.exec(binstr) // 25665
        if (subMatch && subMatch[1]) {
            return Number(subMatch[1])
        }
    }
    return 0;
}

export class LinuxPlatform implements IPlatform {
    async findWmpfProcess(): Promise<WmpfProcessInfo> {
        const localDevice = await frida.getLocalDevice();
        const processes = await localDevice.enumerateProcesses({
            scope: frida.Scope.Metadata,
        });
        const pidMap = new Map(processes.map(p => [p.pid, p]));
        const rootWmpf = processes.find(p => {
            if (p.name !== "WeChatAppEx") return false;
            const ppid = Number(p.parameters.ppid);
            if (!ppid) return false;
            return pidMap.get(ppid)?.name !== "WeChatAppEx";
        });

        if (!rootWmpf) {
            throw new Error("[frida] WeChatAppEx root process not found");
        }

        const wmpfProcessPath = rootWmpf.parameters.path as string | undefined;
        const wmpfVersion = wmpfProcessPath
            ? searchWmpfVersionInFile(wmpfProcessPath)
            : 0;
        if (wmpfVersion === 0) {
            throw new Error("[frida] error in find wmpf version");
        }
        return { pid: rootWmpf.pid, version: wmpfVersion };
    }
}
