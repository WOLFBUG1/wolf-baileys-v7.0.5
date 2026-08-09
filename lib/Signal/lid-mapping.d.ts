export declare class LIDMappingStore {
    constructor(keys: any, logger: any, pnToLIDFunc?: (pns: string[]) => Promise<Array<{
        lid: string;
        pn: string;
    }>>);
    storeLIDPNMappings(pairs: Array<{
        lid: string;
        pn: string;
    }>): Promise<void>;
    getLIDForPN(pn: string): Promise<string | null>;
    getLIDsForPNs(pns: string[]): Promise<Array<{
        lid: string;
        pn: string;
    }> | null>;
    getPNForLID(lid: string): Promise<string | null>;
    getPNsForLIDs(lids: string[]): Promise<Array<{
        lid: string;
        pn: string;
    }> | null>;
    close(): void;
}
