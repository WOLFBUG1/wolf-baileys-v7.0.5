import { SocketConfig } from '../Types';
import { makeNewsletterSocket } from './newsletter';
export declare const USERNAME_QUERY_IDS: {
    CHECK: string;
    CHECK_MULTI: string;
    SET: string;
    GET: string;
    GET_RECOMMENDATIONS: string;
    PIN_SET: string;
};
export declare const USERNAME_CHECK_RESULT: {
    SUCCESS: string;
    INVALID: string;
};
export declare const USERNAME_SOURCE: {
    FB: string;
    IG: string;
    USER_INPUT: string;
    SUGGESTION: string;
};
export type UsernameSource = keyof typeof USERNAME_SOURCE | typeof USERNAME_SOURCE[keyof typeof USERNAME_SOURCE];
export type UsernameCheckResult = {
    available: boolean;
    username: string;
    suggestions?: string[];
    rejectionReasons?: string[];
    suggestionsEligible?: boolean;
};
export type UsernameSetOptions = {
    source?: UsernameSource;
    sessionId?: string;
    pin?: string;
    reserved?: boolean;
};
export type UsernameLookupResult = {
    jid?: string;
    lid?: string;
    contact: boolean;
};
export declare const makeUsernameSocket: (config: SocketConfig) => ReturnType<typeof makeNewsletterSocket> & {
    checkUsername: (username: string, includeSuggestions?: boolean) => Promise<UsernameCheckResult>;
    checkUsernameMulti: (usernames: string[]) => Promise<any>;
    setUsername: (username: string, options?: UsernameSetOptions) => Promise<any>;
    deleteUsername: () => Promise<any>;
    getMyUsername: () => Promise<string | null>;
    getUsernameRecommendations: (source?: UsernameSource | null) => Promise<any>;
    setUsernamePin: (pin: string | null) => Promise<any>;
    findUserByUsername: (username: string, pin?: string) => Promise<UsernameLookupResult | null>;
    fetchContactUsernames: (...jids: string[]) => Promise<Array<{
        id: string;
        username?: string | null;
    }>>;
    USERNAME_QUERY_IDS: typeof USERNAME_QUERY_IDS;
    USERNAME_CHECK_RESULT: typeof USERNAME_CHECK_RESULT;
    USERNAME_SOURCE: typeof USERNAME_SOURCE;
};
