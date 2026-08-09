"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeLibSignalRepository = makeLibSignalRepository;
const libsignal = __importStar(require("libsignal"));
const Utils_1 = require("../Utils");
const WABinary_1 = require("../WABinary");
const sender_key_name_1 = require("./Group/sender-key-name");
const sender_key_record_1 = require("./Group/sender-key-record");
const Group_1 = require("./Group");
const lid_mapping_1 = require("./lid-mapping");
function makeLibSignalRepository(auth, logger, pnToLIDFunc) {
    const lidMapping = new lid_mapping_1.LIDMappingStore(auth.keys, logger, pnToLIDFunc);
    const storage = signalStorage(auth, lidMapping);
    return {
        decryptGroupMessage({ group, authorJid, msg }) {
            const senderName = jidToSignalSenderKeyName(group, authorJid);
            const cipher = new Group_1.GroupCipher(storage, senderName);
            return cipher.decrypt(msg);
        },
        async processSenderKeyDistributionMessage({ item, authorJid }) {
            const builder = new Group_1.GroupSessionBuilder(storage);
            if (!item.groupId) {
                throw new Error('Group ID is required for sender key distribution message');
            }
            const senderName = jidToSignalSenderKeyName(item.groupId, authorJid);
            const senderMsg = new Group_1.SenderKeyDistributionMessage(null, null, null, null, item.axolotlSenderKeyDistributionMessage);
            const senderNameStr = senderName.toString();
            const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
            if (!senderKey) {
                await storage.storeSenderKey(senderName, new sender_key_record_1.SenderKeyRecord());
            }
            await builder.process(senderName, senderMsg);
        },
        async decryptMessage({ jid, type, ciphertext }) {
            const addr = jidToSignalProtocolAddress(jid);
            const session = new libsignal.SessionCipher(storage, addr);
            let result;
            switch (type) {
                case 'pkmsg':
                    result = await session.decryptPreKeyWhisperMessage(ciphertext);
                    break;
                case 'msg':
                    result = await session.decryptWhisperMessage(ciphertext);
                    break;
                default:
                    throw new Error(`Unknown message type: ${type}`);
            }
            return result;
        },
        async encryptMessage({ jid, data }) {
            const addr = jidToSignalProtocolAddress(jid);
            const cipher = new libsignal.SessionCipher(storage, addr);
            const { type: sigType, body } = await cipher.encrypt(data);
            const type = sigType === 3 ? 'pkmsg' : 'msg';
            return { type, ciphertext: Buffer.from(body, 'binary') };
        },
        async encryptGroupMessage({ group, meId, data }) {
            const senderName = jidToSignalSenderKeyName(group, meId);
            const builder = new Group_1.GroupSessionBuilder(storage);
            const senderNameStr = senderName.toString();
            const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr]);
            if (!senderKey) {
                await storage.storeSenderKey(senderName, new sender_key_record_1.SenderKeyRecord());
            }
            const senderKeyDistributionMessage = await builder.create(senderName);
            const session = new Group_1.GroupCipher(storage, senderName);
            const ciphertext = await session.encrypt(data);
            return {
                ciphertext,
                senderKeyDistributionMessage: senderKeyDistributionMessage.serialize()
            };
        },
        async injectE2ESession({ jid, session }) {
            const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid));
            await cipher.initOutgoing(session);
        },
        jidToSignalProtocolAddress(jid) {
            return jidToSignalProtocolAddress(jid).toString();
        },
        lidMapping,
        async validateSession(jid) {
            try {
                const addr = jidToSignalProtocolAddress(jid).toString();
                const session = await storage.loadSession(addr);
                if (!session) {
                    return { exists: false, reason: 'no session' };
                }
                if (typeof session.haveOpenSession === 'function' && !session.haveOpenSession()) {
                    return { exists: false, reason: 'no open session' };
                }
                return { exists: true };
            }
            catch (error) {
                return { exists: false, reason: 'validation error' };
            }
        },
        async deleteSession(jids) {
            if (!jids || !jids.length) {
                return;
            }
            const sessionUpdates = {};
            for (const jid of jids) {
                sessionUpdates[jidToSignalProtocolAddress(jid).toString()] = null;
                if ((0, WABinary_1.isPnUser)(jid)) {
                    const lid = await lidMapping.getLIDForPN(jid);
                    if (lid) {
                        sessionUpdates[jidToSignalProtocolAddress(lid).toString()] = null;
                    }
                }
                else if ((0, WABinary_1.isLidUser)(jid)) {
                    const pn = await lidMapping.getPNForLID(jid);
                    if (pn) {
                        sessionUpdates[jidToSignalProtocolAddress(pn).toString()] = null;
                    }
                }
            }
            await auth.keys.set({ session: sessionUpdates });
        },
        close() {
            lidMapping.close();
        }
    };
}
const jidToSignalProtocolAddress = (jid) => {
    const decoded = (0, WABinary_1.jidDecode)(jid);
    if (!(decoded === null || decoded === void 0 ? void 0 : decoded.user)) {
        throw new Error(`Invalid jid: ${jid}`);
    }
    const { user, device, domainType } = decoded;
    const signalUser = domainType && domainType !== WABinary_1.WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user;
    return new libsignal.ProtocolAddress(signalUser, device || 0);
};
const jidToSignalSenderKeyName = (group, user) => {
    return new sender_key_name_1.SenderKeyName(group, jidToSignalProtocolAddress(user));
};
function signalStorage({ creds, keys }, lidMapping) {
    const legacySignalId = (id) => id.replace(/_(1|2|3)\./, '.');
    const resolveLIDSignalAddress = async (id) => {
        if (!lidMapping || !id.includes('.')) {
            return id;
        }
        const [deviceId, device] = id.split('.');
        const [user, domainTypeText] = deviceId.split('_');
        const domainType = parseInt(domainTypeText || `${WABinary_1.WAJIDDomains.WHATSAPP}`, 10);
        if (domainType === WABinary_1.WAJIDDomains.LID || domainType === WABinary_1.WAJIDDomains.HOSTED_LID) {
            return id;
        }
        const pnJid = `${user}${device !== '0' ? `:${device}` : ''}@${domainType === WABinary_1.WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`;
        const lidForPN = await lidMapping.getLIDForPN(pnJid);
        if (lidForPN) {
            return jidToSignalProtocolAddress(lidForPN).toString();
        }
        return id;
    };
    return {
        loadSession: async (id) => {
            const resolvedId = await resolveLIDSignalAddress(id);
            const ids = resolvedId === id ? [id, legacySignalId(id)] : [resolvedId, id, legacySignalId(id)];
            const sessions = await keys.get('session', [...new Set(ids)]);
            const sess = ids.map(key => sessions[key]).find(Boolean);
            if (sess) {
                return libsignal.SessionRecord.deserialize(sess);
            }
        },
        storeSession: async (id, session) => {
            const resolvedId = await resolveLIDSignalAddress(id);
            await keys.set({ session: { [resolvedId]: session.serialize() } });
        },
        isTrustedIdentity: () => {
            return true;
        },
        loadPreKey: async (id) => {
            const keyId = id.toString();
            const { [keyId]: key } = await keys.get('pre-key', [keyId]);
            if (key) {
                return {
                    privKey: Buffer.from(key.private),
                    pubKey: Buffer.from(key.public)
                };
            }
        },
        removePreKey: (id) => keys.set({ 'pre-key': { [id]: null } }),
        loadSignedPreKey: () => {
            const key = creds.signedPreKey;
            return {
                privKey: Buffer.from(key.keyPair.private),
                pubKey: Buffer.from(key.keyPair.public)
            };
        },
        loadSenderKey: async (senderKeyName) => {
            const keyId = senderKeyName.toString();
            const { [keyId]: key } = await keys.get('sender-key', [keyId]);
            if (key) {
                return sender_key_record_1.SenderKeyRecord.deserialize(key);
            }
            return new sender_key_record_1.SenderKeyRecord();
        },
        storeSenderKey: async (senderKeyName, key) => {
            const keyId = senderKeyName.toString();
            const serialized = JSON.stringify(key.serialize());
            await keys.set({ 'sender-key': { [keyId]: Buffer.from(serialized, 'utf-8') } });
        },
        saveIdentity: async () => false,
        getOurRegistrationId: () => creds.registrationId,
        getOurIdentity: () => {
            const { signedIdentityKey } = creds;
            return {
                privKey: Buffer.from(signedIdentityKey.private),
                pubKey: (0, Utils_1.generateSignalPubKey)(signedIdentityKey.public)
            };
        }
    };
}
