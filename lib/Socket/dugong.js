"use strict";

const crypto = require("crypto");
const { proto } = require("../../WAProto");
const Utils = require("../Utils");

class xeonDugong {
    constructor(utils, waUploadToServer, relayMessageFn) {
        this.utils = utils || Utils;
        this.waUploadToServer = waUploadToServer;
        this.relayMessage = relayMessageFn;
        this.bail = {
            generateWAMessageContent: this.utils.generateWAMessageContent || Utils.generateWAMessageContent,
            generateMessageID: Utils.generateMessageID,
            getContentType: msg => Object.keys((msg && msg.message) || {})[0]
        };
    }

    detectType(content) {
        if (!content || typeof content !== "object") {
            return null;
        }
        if (content.requestPaymentMessage) return "PAYMENT";
        if (content.productMessage) return "PRODUCT";
        if (content.interactiveMessage) return "INTERACTIVE";
        if (content.albumMessage) return "ALBUM";
        if (content.eventMessage) return "EVENT";
        if (content.pollResultMessage) return "POLL_RESULT";
        if (content.groupStatusMessage) return "GROUP_STORY";
        return null;
    }

    _quotedContext(quoted, sender) {
        if (!quoted) {
            return undefined;
        }
        return {
            stanzaId: quoted.key && quoted.key.id,
            participant: (quoted.key && quoted.key.participant) || sender,
            quotedMessage: quoted.message
        };
    }

    async _prepareMedia(kind, value, extra = {}) {
        if (!value) {
            return {};
        }
        const payloadValue = Buffer.isBuffer(value) ? value : value;
        return this.utils.prepareWAMessageMedia({
            [kind]: payloadValue,
            ...extra
        }, {
            upload: this.waUploadToServer
        });
    }

    async handlePayment(content, quoted) {
        const data = content.requestPaymentMessage || {};
        const noteMessage = data.sticker && data.sticker.stickerMessage
            ? {
                stickerMessage: {
                    ...data.sticker.stickerMessage,
                    contextInfo: this._quotedContext(quoted, content.sender)
                }
            }
            : data.note
                ? {
                    extendedTextMessage: {
                        text: data.note,
                        contextInfo: this._quotedContext(quoted, content.sender)
                    }
                }
                : undefined;

        return {
            requestPaymentMessage: proto.Message.RequestPaymentMessage.fromObject({
                expiryTimestamp: data.expiry || 0,
                amount1000: data.amount || 0,
                currencyCodeIso4217: data.currency || "USD",
                requestFrom: data.from || "0@s.whatsapp.net",
                noteMessage,
                background: data.background || {
                    id: "DEFAULT",
                    placeholderArgb: 0xfff0f0f0
                }
            })
        };
    }

    async handleProduct(content) {
        const data = content.productMessage || {};
        let productImage;

        if (data.thumbnail) {
            const media = await this.utils.generateWAMessageContent({
                image: Buffer.isBuffer(data.thumbnail) ? data.thumbnail : data.thumbnail
            }, {
                upload: this.waUploadToServer
            });
            productImage = media.imageMessage;
        }

        return {
            viewOnceMessage: {
                message: {
                    interactiveMessage: {
                        body: { text: data.body || data.description || "" },
                        footer: { text: data.footer || "" },
                        header: {
                            title: data.title || "",
                            hasMediaAttachment: !!productImage,
                            productMessage: {
                                product: {
                                    productImage,
                                    productId: data.productId || "",
                                    title: data.title || "",
                                    description: data.description || "",
                                    currencyCode: data.currencyCode || "USD",
                                    priceAmount1000: data.priceAmount1000 || 0,
                                    retailerId: data.retailerId || "",
                                    url: data.url || "",
                                    productImageCount: productImage ? 1 : 0
                                },
                                businessOwnerJid: "0@s.whatsapp.net"
                            }
                        },
                        nativeFlowMessage: {
                            buttons: data.buttons || []
                        }
                    }
                }
            }
        };
    }

    async handleInteractive(content) {
        const data = content.interactiveMessage || {};
        let media = {};
        let hasMediaAttachment = false;

        if (data.thumbnail) {
            media = await this._prepareMedia("image", { url: data.thumbnail });
            hasMediaAttachment = true;
        }
        else if (data.image) {
            media = await this._prepareMedia("image", data.image);
            hasMediaAttachment = true;
        }
        else if (data.video) {
            media = await this._prepareMedia("video", data.video);
            hasMediaAttachment = true;
        }
        else if (data.document) {
            media = await this._prepareMedia("document", data.document, {
                mimetype: data.mimetype,
                fileName: data.fileName,
                jpegThumbnail: data.jpegThumbnail
            });
            hasMediaAttachment = true;
        }

        const interactiveMessage = {
            body: { text: data.title || "" },
            footer: { text: data.footer || "" },
            header: {
                title: data.header || "",
                hasMediaAttachment,
                ...media
            }
        };

        if (data.buttons && data.buttons.length) {
            interactiveMessage.nativeFlowMessage = {
                buttons: data.buttons,
                ...(data.nativeFlowMessage || {})
            };
        }
        else if (data.nativeFlowMessage) {
            interactiveMessage.nativeFlowMessage = data.nativeFlowMessage;
        }

        const contextInfo = data.contextInfo ? { ...data.contextInfo } : {};
        if (data.externalAdReply) {
            contextInfo.externalAdReply = { ...data.externalAdReply };
        }
        if (Object.keys(contextInfo).length) {
            interactiveMessage.contextInfo = contextInfo;
        }

        return { interactiveMessage };
    }

    async handleAlbum(content, jid, quoted) {
        if (!this.relayMessage) {
            throw new Error("relayMessage is required for album messages");
        }

        const items = Array.isArray(content.albumMessage) ? content.albumMessage : [];
        const album = await this.utils.generateWAMessageFromContent(jid, {
            messageContextInfo: {
                messageSecret: crypto.randomBytes(32)
            },
            albumMessage: {
                expectedImageCount: items.filter(item => Object.prototype.hasOwnProperty.call(item, "image")).length,
                expectedVideoCount: items.filter(item => Object.prototype.hasOwnProperty.call(item, "video")).length
            }
        }, {
            quoted,
            upload: this.waUploadToServer
        });

        await this.relayMessage(jid, album.message, {
            messageId: album.key.id
        });

        for (const item of items) {
            const msg = await this.utils.generateWAMessage(jid, item, {
                quoted,
                upload: this.waUploadToServer
            });
            msg.message.messageContextInfo = {
                ...(msg.message.messageContextInfo || {}),
                messageSecret: crypto.randomBytes(32),
                messageAssociation: {
                    associationType: 1,
                    parentMessageKey: album.key
                }
            };
            await this.relayMessage(jid, msg.message, {
                messageId: msg.key.id
            });
        }

        return album;
    }

    async handleEvent(content, jid, quoted) {
        if (!this.relayMessage) {
            throw new Error("relayMessage is required for event messages");
        }

        const data = content.eventMessage || {};
        const msg = await this.utils.generateWAMessageFromContent(jid, {
            eventMessage: {
                isCanceled: !!data.isCanceled,
                name: data.name || "",
                description: data.description || "",
                location: data.location,
                joinLink: data.joinLink || "",
                startTime: typeof data.startTime === "string" ? parseInt(data.startTime, 10) : data.startTime,
                endTime: typeof data.endTime === "string" ? parseInt(data.endTime, 10) : data.endTime,
                extraGuestsAllowed: data.extraGuestsAllowed !== false
            }
        }, { quoted });

        await this.relayMessage(jid, msg.message, {
            messageId: msg.key.id
        });
        return msg;
    }

    async handlePollResult(content, jid, quoted) {
        if (!this.relayMessage) {
            throw new Error("relayMessage is required for poll-result messages");
        }

        const data = content.pollResultMessage || {};
        const msg = await this.utils.generateWAMessageFromContent(jid, {
            pollResultSnapshotMessage: {
                name: data.name || "",
                pollVotes: (data.pollVotes || []).map(vote => ({
                    optionName: vote.optionName,
                    optionVoteCount: typeof vote.optionVoteCount === "number"
                        ? vote.optionVoteCount.toString()
                        : vote.optionVoteCount
                }))
            }
        }, { quoted });

        await this.relayMessage(jid, msg.message, {
            messageId: msg.key.id
        });
        return msg;
    }

    async handleGroupStory(content, jid, quoted) {
        if (!this.relayMessage) {
            throw new Error("relayMessage is required for group story messages");
        }

        const data = content.groupStatusMessage || {};
        const message = data.message
            ? data.message
            : await this.utils.generateWAMessageContent(data, {
                upload: this.waUploadToServer
            });

        const msg = await this.utils.generateWAMessageFromContent(jid, message, { quoted });
        await this.relayMessage(jid, msg.message, {
            messageId: msg.key.id
        });
        return msg;
    }

    async buildMessageContent(content, opts = {}) {
        const type = this.detectType(content);
        if (!type) {
            return this.utils.generateWAMessageContent(content, opts);
        }

        switch (type) {
            case "PAYMENT":
                return this.handlePayment(content, opts.quoted);
            case "PRODUCT":
                return this.handleProduct(content, opts.jid, opts.quoted);
            case "INTERACTIVE":
                return this.handleInteractive(content, opts.jid, opts.quoted);
            default:
                throw new Error(`${type} messages must be sent through sendMessage`);
        }
    }
}

module.exports = xeonDugong;
