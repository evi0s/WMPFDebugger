import { IPlatform } from "./types";
import { WindowsPlatform } from "./win32";
import { LinuxPlatform } from "./linux";
import { DarwinPlatform } from "./darwin";

function createPlatform(): IPlatform {
    const osPlatform = process.platform;

    switch (osPlatform) {
        case 'win32':
            return new WindowsPlatform();
        case 'linux':
            return new LinuxPlatform();
        case 'darwin':
            return new DarwinPlatform();
        default:
            throw new Error(`Unsupported operating system: ${osPlatform}`);
    }
}

export const platform = createPlatform();
