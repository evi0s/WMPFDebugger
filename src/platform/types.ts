export interface WmpfProcessInfo {
    pid: number;
    version: number;
}

export interface IPlatform {
    findWmpfProcess(): Promise<WmpfProcessInfo>;
}
