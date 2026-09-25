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
    // Fallback for WeChat 4.0.x and earlier: those builds have no `wmpf_release/...`
    // string, the version lives in a comma-prefixed literal like `\0,2.1.4.11459\0`,
    // and is immediately followed by an embedded source path
    // (`.../electron_node/src/node_url.cc:78`). The bare literal shape is far too
    // generic to match on -- any dependency build version looks the same -- so the
    // match is anchored to that trailing source path.
    // Verified on WeChat Linux 4.0.0.30 / 4.1.0.13 / 4.1.0.16 / 4.1.1.4 / 4.1.1.7 /
    // 4.1.1.8: exactly one candidate each, and none on 4.1.13.9 (which has the
    // release string). Note the anchor is the *trailing* string -- the preceding one
    // is not the same kind of path on every build.
    const legacyAnchored =
        /\0,(\d+\.\d+\.\d+\.\d{3,6})\0[^\0]{4,200}\.(?:cc|h|cpp):\d+\0/.exec(binstr);
    if (legacyAnchored && legacyAnchored[1]) {
        return Number(legacyAnchored[1].split(".").pop());
    }
    // Anchor lost (the surrounding layout changed): only trust the bare shape when
    // the file holds a single candidate, otherwise refuse rather than load the
    // config of an unrelated version.
    const legacyBare = /\0,(\d+\.\d+\.\d+\.\d{3,6})\0/g;
    let legacyOnly: string | undefined;
    for (let m = legacyBare.exec(binstr); m; m = legacyBare.exec(binstr)) {
        if (legacyOnly !== undefined) {
            return 0;
        }
        legacyOnly = m[1];
    }
    if (legacyOnly !== undefined) {
        return Number(legacyOnly.split(".").pop());
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
