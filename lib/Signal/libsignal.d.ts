import { SignalAuthState } from '../Types';
import { SignalRepository } from '../Types/Signal';
export declare function makeLibSignalRepository(auth: SignalAuthState, logger?: any, pnToLIDFunc?: (pns: string[]) => Promise<Array<{
    lid: string;
    pn: string;
}>>): SignalRepository;
