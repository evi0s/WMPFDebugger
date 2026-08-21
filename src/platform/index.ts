import { IPlatform } from "./types";
import { WindowsPlatform } from "./win32";

function createPlatform(): IPlatform {
    const osPlatform = process.platform;

    switch (osPlatform) {
        case 'win32':
            return new WindowsPlatform();
        default:
            throw new Error(`Unsupported operating system: ${osPlatform}`)
    }
}

export const platform = createPlatform();
