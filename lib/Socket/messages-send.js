"use strict"; 
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
}; 
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeMessagesSocket = void 0;
const boom_1 = require("@hapi/boom");
const crypto_1 = require("crypto");
const node_cache_1 = __importDefault(require("node-cache"));
const WAProto_1 = require("../../WAProto");
const Defaults_1 = require("../Defaults");
const axios_1 = require("axios")
const Types_1 = require("../Types")
const Utils_1 = require("../Utils");
const link_preview_1 = require("../Utils/link-preview");
const WABinary_1 = require("../WABinary");
const username_1 = require("./username");
const WAUSync_1 = require("../WAUSync")
const xeonDugong = require('./dugong');
var ListType = WAProto_1.proto.Message.ListMessage.ListType;
const makeMessagesSocket = (config) => {
    const {
        logger,
        linkPreviewImageThumbnailWidth, 
        generateHighQualityLinkPreview,
        maxMsgRetryCount,
        options: axiosOptions,
        patchMessageBeforeSending
    } = config;
    const sock = (0, username_1.makeUsernameSocket)(config);
    const {
        ev, 
        authState, 
        processingMutex, 
        signalRepository, 
        upsertMessage,
        query,
        fetchPrivacySettings,
        generateMessageTag,
        sendNode, 
        groupMetadata,
        groupToggleEphemeral,
        executeUSyncQuery
    } = sock;
    const userDevicesCache = config.userDevicesCache || new node_cache_1.default({
        stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.USER_DEVICES,
        useClones: false
    });
    const messageRetryManager = config.messageRetryManager || new Utils_1.MessageRetryManager(logger, maxMsgRetryCount);
    const inFlightTcTokenIssuance = new Set();
    const serverProps = sock.serverProps || {
        privacyTokenOn1to1: true,
        lidTrustedTokenIssueToLid: false
    };
    const isJidBot = (jid) => {
        const user = (jid === null || jid === void 0 ? void 0 : jid.split('@')[0]) || '';
        return /^1313555\d{4}$|^131655500\d{2}$/.test(user) || (jid === null || jid === void 0 ? void 0 : jid.endsWith('@bot'));
    };
    const normalizeLidMappingJid = (jid, fallbackServer) => {
        if (!jid) {
            return ''
        }
        if (jid.includes('@')) {
            return WABinary_1.jidNormalizedUser(jid)
        }
        return WABinary_1.jidEncode(jid, fallbackServer)
    }
    let mediaConn;
    const refreshMediaConn = async (forceGet = false) => {
        const media = await mediaConn;
        if (!media || forceGet || (new Date().getTime() - media.fetchDate.getTime()) > media.ttl * 1000) {
            mediaConn = (async () => {
                const result = await query({
                    tag: 'iq',
                    attrs: {
                        type: 'set',
                        xmlns: 'w:m',
                        to: WABinary_1.S_WHATSAPP_NET,
                    },
                    content: [{ tag: 'media_conn', attrs: {} }]
                });
                const mediaConnNode = WABinary_1.getBinaryNodeChild(result, 'media_conn');
                const node = {
                    hosts: WABinary_1.getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
                        hostname: attrs.hostname,
                        maxContentLengthBytes: +attrs.maxContentLengthBytes,
                    })),
                    auth: mediaConnNode.attrs.auth,
                    ttl: +mediaConnNode.attrs.ttl,
                    fetchDate: new Date()
                };
                logger.debug('fetched media conn');
                return node;
            })();
        }
        return mediaConn;
    };
    /**
     * generic send receipt function
     * used for receipts of phone call, read, delivery etc.
     * */
    const sendReceipt = async (jid, participant, messageIds, type) => {
        const node = {
            tag: 'receipt',
            attrs: {
                id: messageIds[0],
            },
        };
        const isReadReceipt = type === 'read' || type === 'read-self';
        if (isReadReceipt) {
            node.attrs.t = (0, Utils_1.unixTimestampSeconds)().toString();
        }
        if (type === 'sender' && WABinary_1.isJidUser(jid)) {
            node.attrs.recipient = jid;
            node.attrs.to = participant;
        }
        else {
            node.attrs.to = jid;
            if (participant) {
                node.attrs.participant = participant;
            }
        }
        if (type) {
            node.attrs.type = WABinary_1.isJidNewsLetter(jid) ? 'read-self' : type;
        }
        const remainingMessageIds = messageIds.slice(1);
        if (remainingMessageIds.length) {
            node.content = [
                {
                    tag: 'list',
                    attrs: {},
                    content: remainingMessageIds.map(id => ({
                        tag: 'item',
                        attrs: { id }
                    }))
                }
            ];
        }
        logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages');
        await sendNode(node);
    };
    /** Correctly bulk send receipts to multiple chats, participants */
    const sendReceipts = async (keys, type) => {
        const recps = (0, Utils_1.aggregateMessageKeysNotFromMe)(keys);
        for (const { jid, participant, messageIds } of recps) {
            await sendReceipt(jid, participant, messageIds, type);
        }
    };
    /** Bulk read messages. Keys can be from different chats & participants */
    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings();
        // based on privacy settings, we have to change the read type
        const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self';
        await sendReceipts(keys, readType);
    };
    /** Fetch all the devices we've to send a message to */
    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = []

        if (!useCache) {
            logger.debug('not using cache for devices')
        }

        const toFetch = []

        jids = Array.from(new Set(jids))

        for (let jid of jids) {
            const user = WABinary_1.jidDecode(jid)?.user

            jid = WABinary_1.jidNormalizedUser(jid)

            if (useCache) {
                const devices = userDevicesCache.get(user)

                if (devices) {
                    deviceResults.push(...devices)
                    logger.trace({ user }, 'using cache for devices')
                }

                else {
                    toFetch.push(jid)
                }
            }

            else {
                toFetch.push(jid)
            }
        }

        if (!toFetch.length) {
            return deviceResults
        }

        const requestedLidUsers = new Set()
        for (const jid of toFetch) {
            if (WABinary_1.isLidUser(jid) || WABinary_1.isHostedLidUser(jid)) {
                const user = WABinary_1.jidDecode(jid)?.user
                if (user) {
                    requestedLidUsers.add(user)
                }
            }
        }

        const query = new WAUSync_1.USyncQuery()
            .withContext('message')
            .withDeviceProtocol()
            .withLIDProtocol()

        for (const jid of toFetch) {
            query.withUser(new WAUSync_1.USyncUser().withId(jid))
        }

        const result = await executeUSyncQuery(query)

        if (result) {
            const lidResults = result.list?.filter(item => item.lid && item.id) || []
            if (lidResults.length) {
                logger.trace({ count: lidResults.length }, 'storing LID maps from device call')
                await signalRepository.lidMapping.storeLIDPNMappings(lidResults.map(item => ({
                    lid: normalizeLidMappingJid(item.lid, 'lid'),
                    pn: normalizeLidMappingJid(item.id, 's.whatsapp.net')
                })))
            }

            const extracted = Utils_1.extractDeviceJids(result?.list || [], authState.creds.me.id, authState.creds.me.lid, ignoreZeroDevices)
            const deviceMap = {}

            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || []
                deviceMap[item.user].push(item)
                deviceResults.push({
                    ...item,
                    jid: WABinary_1.jidEncode(
                        item.user,
                        requestedLidUsers.has(item.user) ? 'lid' : item.server || 's.whatsapp.net',
                        item.device
                    )
                })
            }

            for (const key in deviceMap) {
                userDevicesCache.set(key, deviceMap[key])
            }
        }

        return deviceResults
    }
    const assertSessions = async (jids, force) => {
        let didFetchNewSession = false;
        const uniqueJids = [...new Set(jids.filter(Boolean))]
        const jidsRequiringFetch = []

        for (const jid of uniqueJids) {
            if (!force) {
                if (typeof signalRepository.validateSession === 'function') {
                    const sessionValidation = await signalRepository.validateSession(jid)
                    if (sessionValidation.exists) {
                        continue
                    }
                }
                else {
                    const signalId = signalRepository.jidToSignalProtocolAddress(jid)
                    const sessions = await authState.keys.get('session', [signalId])
                    if (sessions[signalId]) {
                        continue
                    }
                }
            }

            jidsRequiringFetch.push(jid)
        }

        if (jidsRequiringFetch.length) {
            const pnJids = jidsRequiringFetch.filter(jid => WABinary_1.isPnUser(jid) || WABinary_1.isHostedPnUser(jid))
            const lidMappings = typeof signalRepository.lidMapping?.getLIDsForPNs === 'function'
                ? (await signalRepository.lidMapping.getLIDsForPNs(pnJids)) || []
                : []
            const mappedPnJids = new Set(lidMappings.map(item => item.pn))
            const wireJids = [
                ...jidsRequiringFetch.filter(jid => WABinary_1.isLidUser(jid) || WABinary_1.isHostedLidUser(jid)),
                ...lidMappings.map(item => item.lid),
                ...jidsRequiringFetch.filter(jid => {
                    if (!(WABinary_1.isPnUser(jid) || WABinary_1.isHostedPnUser(jid))) {
                        return !(WABinary_1.isLidUser(jid) || WABinary_1.isHostedLidUser(jid))
                    }

                    return !mappedPnJids.has(jid)
                })
            ]
            const uniqueWireJids = [...new Set(wireJids.filter(Boolean))]
            logger.debug({ jidsRequiringFetch, wireJids: uniqueWireJids }, 'fetching sessions');
            const result = await query({
                tag: 'iq',
                attrs: {
                    xmlns: 'encrypt',
                    type: 'get',
                    to: WABinary_1.S_WHATSAPP_NET,
                },
                content: [
                    {
                        tag: 'key',
                        attrs: {},
                        content: uniqueWireJids.map(jid => {
                            const attrs = { jid }
                            if (force) {
                                attrs.reason = 'identity'
                            }
                            return {
                                tag: 'user',
                                attrs
                            }
                        })
                    }
                ]
            });
            await (0, Utils_1.parseAndInjectE2ESessions)(result, signalRepository);
            didFetchNewSession = true;
        }
        return didFetchNewSession;
    };
    
 
    const sendPeerDataOperationMessage = async (pdoMessage) => {
        if (!authState.creds.me?.id) {
            throw new boom_1.Boom('Not authenticated')
        }
        
        const protocolMessage = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: WAProto_1.proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
            }
        };
        const meJid = WABinary_1.jidNormalizedUser(authState.creds.me.id);
        const msgId = await relayMessage(meJid, protocolMessage, {
            additionalAttributes: {
                category: 'peer',
                // eslint-disable-next-line camelcase
                push_priority: 'high_force',
            },
        });
        return msgId;
    };
    const createParticipantNodes = async (jids, message, extraAttrs, dsmMessage) => {
        if (!jids.length) {
            return { nodes: [], shouldIncludeDeviceIdentity: false };
        }
        const patched = await patchMessageBeforeSending(message, jids);
        const patchedMessages = Array.isArray(patched)
            ? patched
            : jids.map(jid => ({ recipientJid: jid, message: patched }));
        let shouldIncludeDeviceIdentity = false;
        const meId = authState.creds.me.id;
        const meLid = authState.creds?.me?.lid;
        const meLidUser = meLid ? WABinary_1.jidDecode(meLid)?.user : undefined;
        const nodes = (await Promise.all(patchedMessages.map(async ({ recipientJid: jid, message: patchedMessage }) => {
            try {
                if (!jid) {
                    return null;
                }
                let messageToEncrypt = patchedMessage;
                if (dsmMessage) {
                    const targetUser = WABinary_1.jidDecode(jid)?.user;
                    const ownPnUser = WABinary_1.jidDecode(meId)?.user;
                    const isOwnUser = targetUser === ownPnUser || (meLidUser && targetUser === meLidUser);
                    const isExactSenderDevice = jid === meId || (meLid && jid === meLid);
                    if (isOwnUser && !isExactSenderDevice) {
                        messageToEncrypt = dsmMessage;
                    }
                }
                const bytes = (0, Utils_1.encodeWAMessage)(messageToEncrypt);
                const { type, ciphertext } = await signalRepository
                    .encryptMessage({ jid, data: bytes });
                if (type === 'pkmsg') {
                    shouldIncludeDeviceIdentity = true;
                }
                const node = {
                    tag: 'to',
                    attrs: { jid },
                    content: [{
                            tag: 'enc',
                            attrs: {
                                v: '2',
                                type,
                                ...extraAttrs || {}
                            },
                            content: ciphertext
                        }]
                };
                return node;
            }
            catch (error) {
                logger.error({ jid, err: error }, 'failed to encrypt for recipient');
                return null;
            }
        }))).filter(Boolean);
        if (jids.length && !nodes.length) {
            throw new boom_1.Boom('All encryptions failed', { statusCode: 500 });
        }
        return { nodes, shouldIncludeDeviceIdentity };
    }; //apela
    const relayMessage = async (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, cachedGroupMetadata, useCachedGroupMetadata, statusJidList, AI = true, forceLidUserDevices, skipOwnDeviceFanout }) => {
        const meId = authState.creds.me.id;
        let shouldIncludeDeviceIdentity = false;
        let didPushAdditional = false
        const { user, server } = WABinary_1.jidDecode(jid);
        const statusJid = 'status@broadcast';
        const isGroup = server === 'g.us';
        const isStatus = jid === statusJid;
        const isLid = server === 'lid';
        const isPrivate = server === 's.whatsapp.net'
        const isNewsletter = server === 'newsletter';
        const forcedLidUsers = new Set((forceLidUserDevices || [])
            .map(jid => WABinary_1.jidDecode(jid)?.user)
            .filter(Boolean));
        msgId = msgId || Utils_1.generateMessageIDV2(meId);
        useUserDevicesCache = useUserDevicesCache !== false;
        useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus
        const participants = [];
        const destinationJid = (!isStatus) ? WABinary_1.jidEncode(user, isLid ? 'lid' : isGroup ? 'g.us' : isNewsletter ? 'newsletter' : 's.whatsapp.net') : statusJid;
        const binaryNodeContent = [];
        const devices = [];
        const meMsg = {
            deviceSentMessage: {
                destinationJid,
                message
            },
            messageContextInfo: message.messageContextInfo
        };
        const extraAttrs = {}
        const messages = Utils_1.normalizeMessageContent(message)  
        const buttonType = getButtonType(messages);
        if (participant) {
            // when the retry request is not for a group
            // only send to the specific device that asked for a retry
            // otherwise the message is sent out to every device that should be a recipient
            if (!isGroup && !isStatus) {
                additionalAttributes = { ...additionalAttributes, 'device_fanout': 'false' };
            }
            const { user, device, server } = WABinary_1.jidDecode(participant.jid);
            devices.push({ user, device, server });
        }
        await authState.keys.transaction(async () => {
            const mediaType = getMediaType(messages);
            
            if (mediaType) {
                extraAttrs['mediatype'] = mediaType
            }
            
            if (messages.pinInChatMessage || messages.keepInChatMessage || message.reactionMessage || message.protocolMessage?.editedMessage) {
                extraAttrs['decrypt-fail'] = 'hide'
            } 
            
            if (messages.interactiveResponseMessage?.nativeFlowResponseMessage) {
                extraAttrs['native_flow_name'] = messages.interactiveResponseMessage?.nativeFlowResponseMessage.name
            }
            
            if (isGroup || isStatus) {
                const [groupData, senderKeyMap] = await Promise.all([
                    (async () => {
                        let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined
                        if (groupData) {
                            logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata');
                        }

                        else if (!isStatus) {
                            groupData = await groupMetadata(jid)
                        }
                        
                        return groupData;
                    })(),
                    (async () => {
                        if (!participant && !isStatus) {
                            const result = await authState.keys.get('sender-key-memory', [jid])
                            return result[jid] || {}
                        }

                        return {}

                    })()         
                ]);
                if (!participant) {
                    const participantsList = (groupData && !isStatus) ? groupData.participants.map(p => p.id) : []

                    if (isStatus && statusJidList) {
                        participantsList.push(...statusJidList)
                    }

                 //   if (!isStatus) {
                 //       const expiration = await getEphemeralGroup(jid)
                 //       additionalAttributes = {
                 //           ...additionalAttributes, 
                 //           addressing_mode: 'pn',
                 //           ...expiration ? { expiration: expiration.toString() } : null
                 //       }
                 //   }

                    const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
                    devices.push(...additionalDevices)
                }
                
                const patched = await patchMessageBeforeSending(message, devices.map(d => WABinary_1.jidEncode(d.user, d.server || (isLid ? 'lid' : 's.whatsapp.net'), d.device)));
                const bytes = Utils_1.encodeWAMessage(patched);
                
                const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId,
                });
                const senderKeyJids = [];
                
                for (const { user, device, server } of devices) {
                    const jid = WABinary_1.jidEncode(user, server || ((groupData === null || groupData === void 0 ? void 0 : groupData.addressingMode) === 'lid' ? 'lid' : 's.whatsapp.net'), device);
                    if (!senderKeyMap[jid] || !!participant) {
                        senderKeyJids.push(jid);
                        // store that this person has had the sender keys sent to them
                        senderKeyMap[jid] = true;
                    }
                }
                // if there are some participants with whom the session has not been established
                // if there are, we re-send the senderkey
                if (senderKeyJids.length) {
                    logger.debug({ senderKeyJids }, 'sending new sender key');
                    const senderKeyMsg = {
                        senderKeyDistributionMessage: {
                            axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
                            groupId: destinationJid
                        }
                    };
                    await assertSessions(senderKeyJids, false);
                    const result = await createParticipantNodes(senderKeyJids, senderKeyMsg, extraAttrs)
                    shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity;
                    participants.push(...result.nodes);
                }
                binaryNodeContent.push({
                    tag: 'enc',
                    attrs: { v: '2', type: 'skmsg', ...extraAttrs },
                    content: ciphertext
                });
                await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } });
            }
            else if (isNewsletter) {
                // Message edit
                if (message.protocolMessage?.editedMessage) {
                    msgId = message.protocolMessage.key?.id
                    message = message.protocolMessage.editedMessage
                }

                // Message delete
                if (message.protocolMessage?.type === WAProto_1.proto.Message.ProtocolMessage.Type.REVOKE) {
                    msgId = message.protocolMessage.key?.id
                    message = {}
                }

                const patched = await patchMessageBeforeSending(message, [])
                const bytes = Utils_1.encodeNewsletterMessage(patched)

                binaryNodeContent.push({
                    tag: 'plaintext',
                    attrs: extraAttrs ? extraAttrs : {},
                    content: bytes
                })
            }
            else {
                const { user: meUser } = WABinary_1.jidDecode(meId);
                const meLid = authState.creds?.me?.lid;
                const meLidUser = meLid ? WABinary_1.jidDecode(meLid)?.user : undefined;
                const senderIdentityJid = isLid && meLidUser
                    ? WABinary_1.jidEncode(meLidUser, 'lid')
                    : meId;
                const senderUser = isLid && meLidUser ? meLidUser : meUser;
                if (!participant) {
                    devices.push({
                        user,
                        server: isLid ? 'lid' : undefined,
                        jid: WABinary_1.jidEncode(user, isLid ? 'lid' : 's.whatsapp.net')
                    })
                    if (user !== senderUser && !skipOwnDeviceFanout) {
                        devices.push({
                            user: senderUser,
                            server: isLid ? 'lid' : undefined,
                            jid: senderIdentityJid
                        })
                    }

                    if (additionalAttributes?.['category'] !== 'peer') {
                        const additionalDeviceJids = skipOwnDeviceFanout ? [jid] : [senderIdentityJid, jid]
                        const additionalDevices = await getUSyncDevices(additionalDeviceJids, false, false)

                        devices.length = 0
                        devices.push(...additionalDevices)
                    }
                }
                const allJids = [];
                const meJids = [];
                const otherJids = [];
                for (const { user, device, server, jid: deviceJid } of devices) {
                    const isExactSenderDevice = deviceJid === meId || (meLid && deviceJid === meLid)
                    if (isExactSenderDevice) {
                        continue
                    }
                    const isMe = user === meUser || (meLidUser && user === meLidUser)
                    const deviceServer = forcedLidUsers.has(user)
                        ? 'lid'
                        : server || (isLid ? 'lid' : 's.whatsapp.net')
                    const addressUser = isMe && isLid && meLidUser ? meLidUser : user
                    const jid = deviceJid || WABinary_1.jidEncode(addressUser, deviceServer, device)

                    if (isMe) {
                        meJids.push(jid)
                    }

                    else {
                        otherJids.push(jid)
                    }

                    allJids.push(jid)
                }
                const isSelfChatDestination = user === meUser || (meLidUser && user === meLidUser)
                if (!participant && !isSelfChatDestination && !otherJids.length) {
                    throw new boom_1.Boom('No devices resolved for recipient', {
                        statusCode: 421,
                        data: { jid }
                    })
                }
                logger.debug({ destinationJid, deviceCount: allJids.length, meJids, otherJids }, 'private message device routing')
                await assertSessions(allJids, false);
                const [{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 }, { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }] = await Promise.all([
                    createParticipantNodes(meJids, meMsg, extraAttrs),
                    createParticipantNodes(otherJids, message, extraAttrs, meMsg)
                ])
                participants.push(...meNodes);
                participants.push(...otherNodes);
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2;
            }
            if (participants.length) {
                if (additionalAttributes?.['category'] === 'peer') {
                    const peerNode = participants[0]?.content?.[0]

                    if (peerNode) {
                        binaryNodeContent.push(peerNode) // push only enc
                    }
                }

                else {
                    binaryNodeContent.push({
                        tag: 'participants',
                        attrs: {},
                        content: participants
                    })
                }
            }

            const stanza = {
                tag: 'message',
                attrs: {
                    id: msgId,
                    type: getTypeMessage(messages), 
                    ...(additionalAttributes || {})
                },
                content: binaryNodeContent
            }
            // if the participant to send to is explicitly specified (generally retry recp)
            // ensure the message is only sent to that person
            // if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
            if (participant) {
                if (WABinary_1.isJidGroup(destinationJid)) {
                    stanza.attrs.to = destinationJid;
                    stanza.attrs.participant = participant.jid;
                }
                else if (WABinary_1.areJidsSameUser(participant.jid, meId)) {
                    stanza.attrs.to = participant.jid;
                    stanza.attrs.recipient = destinationJid;
                }
                else {
                    stanza.attrs.to = participant.jid;
                }
            }
            else {
                stanza.attrs.to = destinationJid;
            }
            if (shouldIncludeDeviceIdentity) {
                stanza.content.push({
                    tag: 'device-identity',
                    attrs: {},
                    content: (0, Utils_1.encodeSignedDeviceIdentity)(authState.creds.account, true)
                });
                logger.debug({ jid }, 'adding device identity');
            }
     
            if (AI && isPrivate) {
                const botNode = {
                    tag: 'bot', 
                    attrs: {
                        biz_bot: '1'
                    }
                }

                const filteredBizBot = WABinary_1.getBinaryNodeFilter(additionalNodes ? additionalNodes : []) 

                if (filteredBizBot) {
                    stanza.content.push(...additionalNodes) 
                    didPushAdditional = true
                }

                else {
                    stanza.content.push(botNode) 
                }
            }
            
            if(!isNewsletter && buttonType && !isStatus) {             
                const content = WABinary_1.getAdditionalNode(buttonType)
                const filteredNode = WABinary_1.getBinaryNodeFilter(additionalNodes)

                if (filteredNode) {
                    didPushAdditional = true
                    stanza.content.push(...additionalNodes)
                } 
                else {
                    stanza.content.push(...content)
                }
                logger.debug({ jid }, 'adding business node')
            }         

            if (!isNewsletter && !participant && message?.messageContextInfo?.messageSecret && (0, Utils_1.shouldIncludeReportingToken)(message)) {
                try {
                    const encoded = (0, Utils_1.encodeWAMessage)(message);
                    const reportingNode = await (0, Utils_1.getMessageReportingToken)(encoded, message, {
                        id: msgId,
                        fromMe: true,
                        remoteJid: destinationJid,
                        participant: participant === null || participant === void 0 ? void 0 : participant.jid
                    });
                    if (reportingNode) {
                        stanza.content.push(reportingNode);
                        logger.trace({ jid }, 'added reporting token to message');
                    }
                }
                catch (error) {
                    logger.warn({ jid, trace: error === null || error === void 0 ? void 0 : error.stack }, 'failed to attach reporting token');
                }
            }
            const isPeerMessage = (additionalAttributes === null || additionalAttributes === void 0 ? void 0 : additionalAttributes['category']) === 'peer';
            const is1on1Send = !isGroup && !isStatus && !isNewsletter && !participant && !isPeerMessage;
            const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping);
            const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping);
            const tcTokenJid = is1on1Send ? await (0, Utils_1.resolveTcTokenJid)(destinationJid, getLIDForPN) : destinationJid;
            const contactTcTokenData = is1on1Send ? await authState.keys.get('tctoken', [tcTokenJid]) : {};
            const existingTokenEntry = contactTcTokenData[tcTokenJid];
            let tcTokenBuffer = existingTokenEntry === null || existingTokenEntry === void 0 ? void 0 : existingTokenEntry.token;
            if ((tcTokenBuffer === null || tcTokenBuffer === void 0 ? void 0 : tcTokenBuffer.length) && (0, Utils_1.isTcTokenExpired)(existingTokenEntry === null || existingTokenEntry === void 0 ? void 0 : existingTokenEntry.timestamp)) {
                logger.debug({ jid: destinationJid, timestamp: existingTokenEntry === null || existingTokenEntry === void 0 ? void 0 : existingTokenEntry.timestamp }, 'tctoken expired, clearing');
                tcTokenBuffer = undefined;
                const cleared = (existingTokenEntry === null || existingTokenEntry === void 0 ? void 0 : existingTokenEntry.senderTimestamp) !== undefined
                    ? { token: Buffer.alloc(0), senderTimestamp: existingTokenEntry.senderTimestamp }
                    : null;
                try {
                    await authState.keys.set({ tctoken: { [tcTokenJid]: cleared } });
                }
                catch (error) {
                    logger.debug({ jid: destinationJid, err: error === null || error === void 0 ? void 0 : error.message }, 'failed to persist tctoken expiry cleanup');
                }
            }
            if ((tcTokenBuffer === null || tcTokenBuffer === void 0 ? void 0 : tcTokenBuffer.length) && serverProps.privacyTokenOn1to1 !== false) {
                stanza.content.push({ tag: 'tctoken', attrs: {}, content: tcTokenBuffer });
            }
            if (!didPushAdditional && additionalNodes && additionalNodes.length > 0) {
                stanza.content.push(...additionalNodes);
            }

            logger.debug({ msgId }, `sending message to ${participants.length} devices`);
            await sendNode(stanza);
            const normalizedSentMessage = (0, Utils_1.normalizeMessageContent)(message);
            const isProtocolMsg = !!(normalizedSentMessage === null || normalizedSentMessage === void 0 ? void 0 : normalizedSentMessage.protocolMessage);
            const isBotOrPSA = destinationJid === WABinary_1.PSA_WID || isJidBot(destinationJid);
            if (is1on1Send && !isProtocolMsg && !isBotOrPSA && (0, Utils_1.shouldSendNewTcToken)(existingTokenEntry === null || existingTokenEntry === void 0 ? void 0 : existingTokenEntry.senderTimestamp) && !inFlightTcTokenIssuance.has(tcTokenJid)) {
                inFlightTcTokenIssuance.add(tcTokenJid);
                const issueTimestamp = (0, Utils_1.unixTimestampSeconds)();
                (0, Utils_1.resolveIssuanceJid)(destinationJid, serverProps.lidTrustedTokenIssueToLid, getLIDForPN, getPNForLID)
                    .then(issueJid => getPrivacyTokens([issueJid], issueTimestamp))
                    .then(async (result) => {
                    await (0, Utils_1.storeTcTokensFromIqResult)({ result, fallbackJid: tcTokenJid, keys: authState.keys, getLIDForPN });
                    const currentData = await authState.keys.get('tctoken', [tcTokenJid]);
                    const currentEntry = currentData[tcTokenJid];
                    const indexWrite = await (0, Utils_1.buildMergedTcTokenIndexWrite)(authState.keys, [tcTokenJid]);
                    await authState.keys.set({
                        tctoken: {
                            [tcTokenJid]: { token: Buffer.alloc(0), ...currentEntry, senderTimestamp: issueTimestamp },
                            ...indexWrite
                        }
                    });
                })
                    .catch(error => logger.debug({ jid: destinationJid, err: error === null || error === void 0 ? void 0 : error.message }, 'fire-and-forget tctoken issuance failed'))
                    .finally(() => inFlightTcTokenIssuance.delete(tcTokenJid));
            }
        });
        
        messageRetryManager.addRecentMessage(jid, msgId, message);
        message = Types_1.WAProto.Message.fromObject(message)
    
        const messageJSON = {
            key: {
               remoteJid: jid,
               fromMe: true,
               id: msgId
            },
            message: message,
            messageTimestamp: Utils_1.unixTimestampSeconds(new Date()),
            messageStubParameters: [],
            participant: WABinary_1.isJidGroup(jid) || WABinary_1.isJidStatusBroadcast(jid) ? meId : undefined,
            status: Types_1.WAMessageStatus.PENDING
        }

        return Types_1.WAProto.WebMessageInfo.fromObject(messageJSON)
     //   return msgId;
    };
    const getTypeMessage = (msg) => {
            const message = Utils_1.normalizeMessageContent(msg)  
        if (message.reactionMessage) {
            return 'reaction'
        }       
        else if (getMediaType(message)) {
            return 'media'
        }        
        else {
            return 'text'
        }
    }

    const getMediaType = (message) => {
        if (message.imageMessage) {
            return 'image'
        }
        else if (message.videoMessage) {
            return message.videoMessage.gifPlayback ? 'gif' : 'video'
        }
        else if (message.audioMessage) {
            return message.audioMessage.ptt ? 'ptt' : 'audio'
        }
        else if (message.contactMessage) {
            return 'vcard'
        }
        else if (message.documentMessage) {
            return 'document'
        }
        else if (message.contactsArrayMessage) {
            return 'contact_array'
        }
        else if (message.liveLocationMessage) {
            return 'livelocation'
        }
        else if (message.stickerMessage) {
            return 'sticker'
        }
        else if (message.listMessage) {
            return 'list'
        }
        else if (message.listResponseMessage) {
            return 'list_response'
        }
        else if (message.buttonsResponseMessage) {
            return 'buttons_response'
        }
        else if (message.orderMessage) {
            return 'order'
        }
        else if (message.productMessage) {
            return 'product'
        }
        else if (message.interactiveResponseMessage) {
            return 'native_flow_response'
        }
        else if (message.groupInviteMessage) {
            return 'url'
        }
        else if (/https:\/\/wa\.me\/p\/\d+\/\d+/.test(message.extendedTextMessage?.text)) {
            return 'productlink'
        }
    }
 
    const getButtonType = (message) => {
        if (message.listMessage) {
            return 'list'
        }
        else if (message.buttonsMessage) {
            return 'buttons'
        }
        else if (message.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'review_and_pay') {
            return 'review_and_pay'
        }
        else if (message.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'review_order') {
            return 'review_order'
        }
        else if (message.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'payment_info') {
            return 'payment_info'
        }
        else if (message.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'payment_status') {
            return 'payment_status'
        }
        else if (message.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name === 'payment_method') {
            return 'payment_method'
        }
        else if (message.interactiveMessage && message.interactiveMessage?.nativeFlowMessage) {
            return 'interactive'
        }
        else if (message.interactiveMessage?.nativeFlowMessage) {
            return 'native_flow'
        }
    }
    const normalizeUsernameForSend = (username) => {
        if (typeof username !== 'string') {
            throw new boom_1.Boom('username must be a string', { statusCode: 400 });
        }
        const normalized = username.trim().replace(/^@+/, '');
        if (!normalized) {
            throw new boom_1.Boom('username is required', { statusCode: 400 });
        }
        return normalized;
    };
    const getPrivacyTokens = async (jids, timestamp) => {
        const t = (timestamp !== null && timestamp !== void 0 ? timestamp : (0, Utils_1.unixTimestampSeconds)()).toString();
        const result = await query({
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'privacy'
            },
            content: [
                {
                    tag: 'tokens',
                    attrs: {},
                    content: jids.map(jid => ({
                        tag: 'token',
                        attrs: {
                            jid: WABinary_1.jidNormalizedUser(jid),
                            t,
                            type: 'trusted_contact'
                        }
                    }))
                }
            ]
        });
        return result;
    }  
    const waUploadToServer = (0, Utils_1.getWAUploadToServer)(config, refreshMediaConn);
    const uploadLatexImageToServer = async (buffer, mediaType = 'image', options = {}) => {
        const sha = (0, crypto_1.createHash)('sha256').update(buffer).digest('base64');
        const { directPath, mediaUrl } = await waUploadToServer((0, Utils_1.toReadable)(buffer), {
            mediaType: options.mediaType || 'product-catalog-image',
            fileEncSha256B64: sha,
            timeoutMs: options.timeoutMs || options.mediaUploadTimeoutMs
        });
        return {
            url: mediaUrl || (directPath ? (0, Utils_1.getUrlFromDirectPath)(directPath) : undefined),
            directPath
        };
    };
    const resolveComposedMessageTarget = async (target, options = {}) => {
        if (typeof target !== 'string' || !target.trim().startsWith('@')) {
            return { jid: target, relayOptions: options };
        }
        const normalizedUsername = normalizeUsernameForSend(target);
        const lookup = await sock.findUserByUsername(normalizedUsername, options.usernamePin);
        if (!(lookup === null || lookup === void 0 ? void 0 : lookup.jid)) {
            throw new boom_1.Boom(`No WhatsApp user found for @${normalizedUsername}`, {
                statusCode: 404,
                data: { username: normalizedUsername, lookup }
            });
        }
        const jid = WABinary_1.jidNormalizedUser(lookup.jid);
        const isLid = WABinary_1.isLidUser(jid) || WABinary_1.isHostedLidUser(jid);
        if (isLid && options.refreshPrivacyToken !== false) {
            try {
                const result = await getPrivacyTokens([jid], (0, Utils_1.unixTimestampSeconds)());
                await (0, Utils_1.storeTcTokensFromIqResult)({
                    result,
                    fallbackJid: jid,
                    keys: authState.keys,
                    getLIDForPN: signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
                });
                const indexWrite = await (0, Utils_1.buildMergedTcTokenIndexWrite)(authState.keys, [jid]);
                await authState.keys.set({ tctoken: indexWrite });
            }
            catch (error) {
                logger.debug({ username: normalizedUsername, jid, err: error === null || error === void 0 ? void 0 : error.message }, 'failed to refresh composed username privacy token');
            }
        }
        return {
            jid,
            relayOptions: {
                additionalAttributes: isLid
                    ? { ...(options.additionalAttributes || {}), peer_recipient_username: normalizedUsername }
                    : options.additionalAttributes,
                forceLidUserDevices: isLid ? [jid] : options.forceLidUserDevices,
                skipOwnDeviceFanout: options.skipOwnDeviceFanout,
                useUserDevicesCache: options.useUserDevicesCache !== undefined ? options.useUserDevicesCache : false,
                useCachedGroupMetadata: options.useCachedGroupMetadata
            },
            usernameLookup: { username: normalizedUsername, jid, lookup, route: 'username-lookup' }
        };
    };
    const relayComposedMessage = async (target, message, messageId, options = {}) => {
        const resolved = await resolveComposedMessageTarget(target, options);
        await relayMessage(resolved.jid, message, { messageId, ...resolved.relayOptions });
        return { message, messageId, ...(resolved.usernameLookup ? { usernameLookup: resolved.usernameLookup } : {}) };
    };
    const rahmi = new xeonDugong(Utils_1, waUploadToServer, relayMessage);
    const waitForMsgMediaUpdate = (0, Utils_1.bindWaitForEvent)(ev, 'messages.media-update');
    return {
        ...sock,
        getPrivacyTokens,
        issuePrivacyTokens: getPrivacyTokens,
        assertSessions,
        relayMessage,
        messageRetryManager,
        sendReceipt,
        sendReceipts,
        rahmi,
        readMessages,
        refreshMediaConn,
        getUSyncDevices,
        createParticipantNodes,
        waUploadToServer,
        sendPeerDataOperationMessage,
        fetchPrivacySettings,
        updateMediaMessage: async (message) => {
            const content = (0, Utils_1.assertMediaContent)(message.message);
            const mediaKey = content.mediaKey;
            const meId = authState.creds.me.id;
            const node = (0, Utils_1.encryptMediaRetryRequest)(message.key, mediaKey, meId);
            let error = undefined;
            await Promise.all([
                sendNode(node),
                waitForMsgMediaUpdate(update => {
                    const result = update.find(c => c.key.id === message.key.id);
                    if (result) {
                        if (result.error) {
                            error = result.error;
                        }
                        else {
                            try {
                                const media = (0, Utils_1.decryptMediaRetryData)(result.media, mediaKey, result.key.id);
                                if (media.result !== WAProto_1.proto.MediaRetryNotification.ResultType.SUCCESS) {
                                    const resultStr = WAProto_1.proto.MediaRetryNotification.ResultType[media.result];
                                    throw new boom_1.Boom(`Media re-upload failed by device (${resultStr})`, { data: media, statusCode: (0, Utils_1.getStatusCodeForMediaRetry)(media.result) || 404 });
                                }
                                content.directPath = media.directPath;
                                content.url = (0, Utils_1.getUrlFromDirectPath)(content.directPath);
                                logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful');
                            }
                            catch (err) {
                                error = err;
                            }
                        }
                        return true;
                    }
                })
            ]);
            if (error) {
                throw error;
            }
            ev.emit('messages.update', [
                {
                    key: message.key,
                    update: { 
                        message: message.message
                    }
                }
            ]);
            return message;
        },
        sendTable: async (jid, title, headers, rows, quoted, options = {}) => {
            const { message, messageId } = (0, Utils_1.generateTableContent)(title, headers, rows, quoted, options);
            return relayComposedMessage(jid, message, messageId, options);
        },
        sendList: async (jid, title, items, quoted, options = {}) => {
            const { message, messageId } = (0, Utils_1.generateListContent)(title, items, quoted, options);
            return relayComposedMessage(jid, message, messageId, options);
        },
        sendCodeBlock: async (jid, code, quoted, options = {}) => {
            const { message, messageId } = (0, Utils_1.generateCodeBlockContent)(code, quoted, options);
            return relayComposedMessage(jid, message, messageId, options);
        },
        sendLatex: async (jid, quoted, options = {}) => {
            const { message, messageId } = (0, Utils_1.generateLatexContent)(quoted, options);
            return relayComposedMessage(jid, message, messageId, options);
        },
        sendLatexImage: async (jid, quoted, options = {}, renderLatexToPng, uploadFn) => {
            const upload = uploadFn || ((buffer, mediaType) => uploadLatexImageToServer(buffer, mediaType, options));
            const { message, messageId } = await (0, Utils_1.generateLatexImageContent)(quoted, options, upload, renderLatexToPng);
            return relayComposedMessage(jid, message, messageId, options);
        },
        sendLatexInlineImage: async (jid, quoted, options = {}, renderLatexToPng, uploadFn) => {
            const upload = uploadFn || ((buffer, mediaType) => uploadLatexImageToServer(buffer, mediaType, options));
            const { message, messageId } = await (0, Utils_1.generateLatexInlineImageContent)(quoted, options, upload, renderLatexToPng);
            return relayComposedMessage(jid, message, messageId, options);
        },
        captureUnifiedResponse: Utils_1.captureUnifiedResponse,
        sendUnifiedResponse: async (jid, quoted, captured, options = {}) => {
            const { message, messageId } = (0, Utils_1.generateUnifiedResponseContent)(quoted, captured, options);
            return relayComposedMessage(jid, message, messageId, options);
        },
        sendRichMessage: async (jid, submessages, quoted, options = {}) => {
            const { message, messageId } = (0, Utils_1.generateRichMessageContent)(submessages, quoted, options);
            return relayComposedMessage(jid, message, messageId, options);
        },
        sendMessageToUsername: async function (username, content, options = {}) {
            const normalizedUsername = normalizeUsernameForSend(username);
            const attempts = [];
            const lookup = await sock.findUserByUsername(normalizedUsername, options.usernamePin);
            if (!(lookup === null || lookup === void 0 ? void 0 : lookup.jid)) {
                throw new boom_1.Boom(`No WhatsApp user found for @${normalizedUsername}`, {
                    statusCode: 404,
                    data: { username: normalizedUsername, lookup }
                });
            }
            const pushCandidate = (candidates, jid, reason) => {
                if (!jid || candidates.some(item => item.jid === jid)) {
                    return;
                }
                candidates.push({ jid, reason });
            };
            const candidates = [];
            const lookupJid = WABinary_1.jidNormalizedUser(lookup.jid);
            const isLookupLid = WABinary_1.isLidUser(lookupJid) || WABinary_1.isHostedLidUser(lookupJid);
            if (isLookupLid && signalRepository.lidMapping) {
                const mappedPn = await signalRepository.lidMapping.getPNForLID(lookupJid);
                pushCandidate(candidates, mappedPn, 'stored-pn-mapping');
                try {
                    await getUSyncDevices([lookupJid], false, true);
                    const refreshedPn = await signalRepository.lidMapping.getPNForLID(lookupJid);
                    pushCandidate(candidates, refreshedPn, 'refreshed-pn-mapping');
                }
                catch (error) {
                    attempts.push({
                        jid: lookupJid,
                        stage: 'devices',
                        error: (error === null || error === void 0 ? void 0 : error.message) || `${error}`
                    });
                }
            }
            pushCandidate(candidates, lookupJid, 'username-lookup');
            const keyedControlContent = !!(content && typeof content === 'object' && (content.react?.key || content.edit || content.delete));
            const orderedCandidates = isLookupLid && keyedControlContent
                ? [...candidates].sort((a, b) => {
                    const aIsLookup = a.jid === lookupJid;
                    const bIsLookup = b.jid === lookupJid;
                    return aIsLookup === bIsLookup ? 0 : aIsLookup ? -1 : 1;
                })
                : candidates;
            if (isLookupLid && options.refreshPrivacyToken !== false) {
                try {
                    const issueTimestamp = (0, Utils_1.unixTimestampSeconds)();
                    const result = await getPrivacyTokens([lookupJid], issueTimestamp);
                    await (0, Utils_1.storeTcTokensFromIqResult)({
                        result,
                        fallbackJid: lookupJid,
                        keys: authState.keys,
                        getLIDForPN: signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
                    });
                    const indexWrite = await (0, Utils_1.buildMergedTcTokenIndexWrite)(authState.keys, [lookupJid]);
                    await authState.keys.set({ tctoken: indexWrite });
                    logger.debug({ username: normalizedUsername, jid: lookupJid }, 'refreshed username privacy token before send');
                }
                catch (error) {
                    attempts.push({
                        jid: lookupJid,
                        stage: 'privacy-token-refresh',
                        error: (error === null || error === void 0 ? void 0 : error.message) || `${error}`
                    });
                    logger.debug({ username: normalizedUsername, jid: lookupJid, err: error === null || error === void 0 ? void 0 : error.message }, 'failed to refresh username privacy token before send');
                }
            }
            for (const candidate of orderedCandidates) {
                const candidateIsLid = WABinary_1.isLidUser(candidate.jid) || WABinary_1.isHostedLidUser(candidate.jid);
                const sendOptions = {
                    ...options,
                    messageId: options.messageId || Utils_1.generateMessageIDV2(authState.creds.me.id),
                    additionalAttributes: candidateIsLid
                        ? {
                            ...(options.additionalAttributes || {}),
                            peer_recipient_username: normalizedUsername
                        }
                        : options.additionalAttributes,
                    filter: false,
                    participant: undefined,
                    forceLidUserDevices: candidateIsLid
                        ? [candidate.jid]
                        : options.forceLidUserDevices,
                    skipOwnDeviceFanout: options.skipOwnDeviceFanout !== undefined ? options.skipOwnDeviceFanout : false,
                    useUserDevicesCache: options.useUserDevicesCache !== undefined ? options.useUserDevicesCache : false
                };
                delete sendOptions.usernamePin;
                try {
                    await assertSessions([candidate.jid], true);
                    let candidateContent = content;
                    // Reactions reference an existing message key. Username sends
                    // may be routed through PN while the actual chat is addressed
                    // as LID, so make the referenced key use the LID chat address.
                    if (isLookupLid && keyedControlContent) {
                        const normalizedKey = key => ({ ...key, remoteJid: lookupJid });
                        if (content.react?.key) {
                            candidateContent = { ...content, react: { ...content.react, key: normalizedKey(content.react.key) } };
                        }
                        else if (content.edit) {
                            candidateContent = { ...content, edit: normalizedKey(content.edit) };
                        }
                        else if (content.delete) {
                            candidateContent = { ...content, delete: normalizedKey(content.delete) };
                        }
                    }
                    const sent = await this.sendMessage(candidate.jid, candidateContent, sendOptions);
                    if (sent) {
                        sent.usernameLookup = {
                            username: normalizedUsername,
                            jid: candidate.jid,
                            lookup,
                            route: candidate.reason,
                            attempts
                        };
                    }
                    return sent;
                }
                catch (error) {
                    attempts.push({
                        jid: candidate.jid,
                        route: candidate.reason,
                        stage: 'send',
                        error: (error === null || error === void 0 ? void 0 : error.message) || `${error}`
                    });
                }
            }
            throw new boom_1.Boom(`Failed to send message to @${normalizedUsername}`, {
                statusCode: 428,
                data: {
                    username: normalizedUsername,
                    lookup,
                    attempts
                }
            });
        },
        sendMessage: async (jid, content, options = {}) => {
            const userJid = authState.creds.me.id;
            delete options.ephemeralExpiration
            const { filter = false, quoted, participant } = options;
            const getParticipantAttr = () => participant ? { participant } : filter ? { participant: { jid, count: 0 } } : {};
            const messageType = rahmi.detectType(content);
            if (typeof content === 'object' && 'disappearingMessagesInChat' in content &&
                typeof content['disappearingMessagesInChat'] !== 'undefined' && WABinary_1.isJidGroup(jid)) {
                const { disappearingMessagesInChat } = content

                const value = typeof disappearingMessagesInChat === 'boolean' ?
                    (disappearingMessagesInChat ? Defaults_1.WA_DEFAULT_EPHEMERAL : 0) :
                    disappearingMessagesInChat

                await groupToggleEphemeral(jid, value)
            }
            
            else {
                let mediaHandle

   
            if (messageType) {
                switch(messageType) {
                    case 'PAYMENT':
                        const paymentContent = await rahmi.handlePayment(content, quoted);
                        return await relayMessage(jid, paymentContent, {
                            messageId: Utils_1.generateMessageID(),
                            ...getParticipantAttr()
                        });
                
                    case 'PRODUCT':
                        const productContent = await rahmi.handleProduct(content, jid, quoted);
                        const productMsg = await Utils_1.generateWAMessageFromContent(jid, productContent, { quoted });
                        return await relayMessage(jid, productMsg.message, {
                            messageId: productMsg.key.id,
                            ...getParticipantAttr()
                        });
                
                    case 'INTERACTIVE':
                        const interactiveContent = await rahmi.handleInteractive(content, jid, quoted);
                        const interactiveMsg = await Utils_1.generateWAMessageFromContent(jid, interactiveContent, { quoted });
                        return await relayMessage(jid, interactiveMsg.message, {
                            messageId: interactiveMsg.key.id,
                            ...getParticipantAttr()
                        });
                    case 'ALBUM':
                        return await rahmi.handleAlbum(content, jid, quoted)
                    case 'EVENT':
                        return await rahmi.handleEvent(content, jid, quoted)
                    case 'POLL_RESULT':
                        return await rahmi.handlePollResult(content, jid, quoted)
                    case 'GROUP_STORY':
                        return await rahmi.handleGroupStory(content, jid, quoted)
                }
            }
            const fullMsg = await Utils_1.generateWAMessage(jid, content, {
                logger,
                userJid,
                quoted,
                getUrlInfo: text => link_preview_1.getUrlInfo(text, {
                    thumbnailWidth: linkPreviewImageThumbnailWidth,
                    fetchOpts: {
                        timeout: 3000,
                        ...axiosOptions || {}
                    },
                    logger,
                    uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
                }),
                upload: async (readStream, opts) => {
                    const up = await waUploadToServer(readStream, {
                        ...opts,
                        newsletter: WABinary_1.isJidNewsLetter(jid)
                    });
                    return up;
                },
                mediaCache: config.mediaCache,
                options: config.options,
                ...options
            });
            
            const isDeleteMsg = 'delete' in content && !!content.delete;
            const isEditMsg = 'edit' in content && !!content.edit;
            const isAiMsg = 'ai' in content && !!content.ai;
            
            const additionalAttributes = { ...(options.additionalAttributes || {}) };
            const additionalNodes = [];

            if (isDeleteMsg) {
                const fromMe = content.delete?.fromMe;
                const isGroup = WABinary_1.isJidGroup(content.delete?.remoteJid);
                additionalAttributes.edit = (isGroup && !fromMe) || WABinary_1.isJidNewsLetter(jid) ? '8' : '7';
            } else if (isEditMsg) {
                additionalAttributes.edit = WABinary_1.isJidNewsLetter(jid) ? '3' : '1';
            } else if (isAiMsg) {
                additionalNodes.push({
                    attrs: { 
                        biz_bot: '1' 
                    }, tag: "bot" 
                });
            }
            
            await relayMessage(jid, fullMsg.message, {
                messageId: fullMsg.key.id,
                ...getParticipantAttr(),
                cachedGroupMetadata: options.cachedGroupMetadata,
                additionalNodes: isAiMsg ? additionalNodes : options.additionalNodes,
                additionalAttributes,
                useUserDevicesCache: options.useUserDevicesCache,
                useCachedGroupMetadata: options.useCachedGroupMetadata,
                forceLidUserDevices: options.forceLidUserDevices,
                skipOwnDeviceFanout: options.skipOwnDeviceFanout,
                statusJidList: options.statusJidList
            });
            
            if (config.emitOwnEvents) {
                process.nextTick(() => {
                    processingMutex.mutex(() => upsertMessage(fullMsg, 'append'));
                });
            }
            return fullMsg;
            }
        }
    }
};
exports.makeMessagesSocket = makeMessagesSocket;
