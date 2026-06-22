import { promises } from "node:fs";
import path from "node:path";

const CONFIG_FILE_PATTERN = /^addresses\.(\d+)\.json$/;

const getSupportedVersions = async (configDir: string): Promise<number[]> => {
    const entries = await promises.readdir(configDir);
    return entries
        .map((entry) => entry.match(CONFIG_FILE_PATTERN)?.[1])
        .filter((version): version is string => version !== undefined)
        .map(Number)
        .sort((a, b) => a - b);
};

const readVersionConfig = async (
    projectRoot: string,
    wmpfVersion: number,
): Promise<string> => {
    const configDir = path.join(projectRoot, "frida/config");
    const version = Number(wmpfVersion);
    try {
        const configContent = await promises.readFile(
            path.join(configDir, `addresses.${version}.json`),
        );
        return JSON.stringify(JSON.parse(configContent.toString()));
    } catch (error) {
        const supportedVersions = await getSupportedVersions(configDir);
        throw new Error(
            createUnsupportedVersionMessage(version, supportedVersions),
        );
    }
};

const createUnsupportedVersionMessage = (
    version: number,
    supportedVersions: number[],
): string => {
    const versions = supportedVersions.length
        ? [...supportedVersions].sort((a, b) => a - b).join(", ")
        : "none";
    return (
        `[frida] version config not found: ${version}\n` +
        `[frida] supported versions: ${versions}\n` +
        `[frida] add frida/config/addresses.${version}.json or run with a supported WMPF runtime version`
    );
};

export {
    createUnsupportedVersionMessage,
    getSupportedVersions,
    readVersionConfig,
};
