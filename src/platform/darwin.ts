import { IPlatform, WmpfProcessInfo } from "./types";
import * as frida from "frida";
import { promises } from "node:fs";


const getWmpfVersion = async (): Promise<number> => {
    const infoPlist = (await promises.readFile("/Applications/WeChat.app/Contents/MacOS/WeChatAppEx.app/Contents/Info.plist")).toString();
    const wmpfVersion = infoPlist.match(
            /<key>\s*CFBundleVersion\s*<\/key>\s*<string>([^<]*)<\/string>/
        )?.[1];
    return Number(wmpfVersion);
}

export class DarwinPlatform implements IPlatform {
    async findWmpfProcess(): Promise<WmpfProcessInfo> {
        const localDevice = await frida.getLocalDevice();
        const processes = await localDevice.enumerateProcesses({
            scope: frida.Scope.Metadata,
        });

        const helperProcess = processes.find(
            (p) => p.name === "WeChatAppEx Helper" && p.parameters.ppid,
        );

        if (!helperProcess) {
            throw new Error("[frida] WeChatAppEx Helper process not found");
        }

        const wmpfPid = Number(helperProcess.parameters.ppid);

        const wmpfVersion = await getWmpfVersion();

        return { pid: wmpfPid, version: wmpfVersion }
    }
}
