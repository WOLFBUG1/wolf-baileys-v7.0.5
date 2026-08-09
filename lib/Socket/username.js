"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeUsernameSocket = exports.USERNAME_SOURCE = exports.USERNAME_CHECK_RESULT = exports.USERNAME_QUERY_IDS = void 0;
const WAUSync_1 = require("../WAUSync");
const newsletter_1 = require("./newsletter");
exports.USERNAME_QUERY_IDS = {
    CHECK: '26124072630599520',
    CHECK_MULTI: '27134626522840290',
    SET: '27108705368767936',
    GET: '32618050064506056',
    GET_RECOMMENDATIONS: '26077456248616956',
    PIN_SET: '25529696019976770'
};
exports.USERNAME_CHECK_RESULT = {
    SUCCESS: 'SUCCESS',
    INVALID: 'INVALID'
};
exports.USERNAME_SOURCE = {
    FB: 'FB',
    IG: 'IG',
    USER_INPUT: 'USER_INPUT',
    SUGGESTION: 'SUGGESTION'
};
const makeUsernameSocket = (config) => {
    const sock = (0, newsletter_1.makeNewsletterSocket)(config);
    const { query, generateMessageTag, executeUSyncQuery } = sock;
    const mexQuery = (variables, queryId, dataPath) => (0, newsletter_1.executeWMexQuery)(variables, queryId, dataPath, query, generateMessageTag);
    const checkUsername = async (username, includeSuggestions = true) => {
        const data = await mexQuery({ username, include_suggestions: includeSuggestions }, exports.USERNAME_QUERY_IDS.CHECK, 'xwa2_username_check');
        if ((data === null || data === void 0 ? void 0 : data.result) === exports.USERNAME_CHECK_RESULT.SUCCESS) {
            return { available: true, username };
        }
        return {
            available: false,
            username,
            suggestions: (data === null || data === void 0 ? void 0 : data.suggestions) || [],
            rejectionReasons: (data === null || data === void 0 ? void 0 : data.rejection_reasons) || [],
            suggestionsEligible: (data === null || data === void 0 ? void 0 : data.suggestions_eligible) !== false
        };
    };
    const checkUsernameMulti = async (usernames) => mexQuery({ usernames }, exports.USERNAME_QUERY_IDS.CHECK_MULTI, 'xwa2_username_check_multi');
    const setUsername = async (username, options = {}) => {
        const { source = exports.USERNAME_SOURCE.USER_INPUT, sessionId, pin, reserved = false } = options;
        const variables = {
            username,
            reserved,
            source,
            ...(sessionId ? { session_id: sessionId } : {}),
            ...(pin ? { pin } : {})
        };
        return mexQuery(variables, exports.USERNAME_QUERY_IDS.SET, 'xwa2_username_set');
    };
    const deleteUsername = async () => mexQuery({ username: null }, exports.USERNAME_QUERY_IDS.SET, 'xwa2_username_delete');
    const getMyUsername = async () => {
        const data = await mexQuery({}, exports.USERNAME_QUERY_IDS.GET, 'xwa2_username_get');
        return (data === null || data === void 0 ? void 0 : data.username) || null;
    };
    const getUsernameRecommendations = async (source = null) => {
        const variables = {};
        if (source) {
            variables.source = source;
        }
        return mexQuery(variables, exports.USERNAME_QUERY_IDS.GET_RECOMMENDATIONS, 'xwa2_username_get_recommendations');
    };
    const setUsernamePin = async (pin) => mexQuery({ pin }, exports.USERNAME_QUERY_IDS.PIN_SET, 'xwa2_username_pin_set');
    const findUserByUsername = async (username, pin) => {
        const usyncQuery = new WAUSync_1.USyncQuery().withContactProtocol();
        const user = new WAUSync_1.USyncUser().withUsername(username);
        if (pin) {
            user.withUsernameKey(pin);
        }
        usyncQuery.withUser(user);
        const result = await executeUSyncQuery(usyncQuery);
        if (!(result === null || result === void 0 ? void 0 : result.list) || !result.list.length) {
            return null;
        }
        const entry = result.list[0];
        return {
            jid: entry.id,
            lid: entry.lid,
            contact: (entry === null || entry === void 0 ? void 0 : entry.contact) || false
        };
    };
    const fetchContactUsernames = async (...jids) => {
        const usyncQuery = new WAUSync_1.USyncQuery().withUsernameProtocol();
        for (const jid of jids) {
            usyncQuery.withUser(new WAUSync_1.USyncUser().withId(jid));
        }
        const result = await executeUSyncQuery(usyncQuery);
        return (result === null || result === void 0 ? void 0 : result.list) || [];
    };
    return {
        ...sock,
        checkUsername,
        checkUsernameMulti,
        setUsername,
        deleteUsername,
        getMyUsername,
        getUsernameRecommendations,
        setUsernamePin,
        findUserByUsername,
        fetchContactUsernames,
        USERNAME_QUERY_IDS: exports.USERNAME_QUERY_IDS,
        USERNAME_CHECK_RESULT: exports.USERNAME_CHECK_RESULT,
        USERNAME_SOURCE: exports.USERNAME_SOURCE
    };
};
exports.makeUsernameSocket = makeUsernameSocket;
