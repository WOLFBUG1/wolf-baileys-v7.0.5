/// <reference types="node" />
import { BinaryNode } from '../WABinary';
export declare const shouldIncludeReportingToken: (message: any) => boolean;
export declare const getMessageReportingToken: (msgProtobuf: Buffer, message: any, key: {
    id?: string;
    fromMe?: boolean;
    remoteJid?: string;
    participant?: string;
}) => Promise<BinaryNode | null>;
