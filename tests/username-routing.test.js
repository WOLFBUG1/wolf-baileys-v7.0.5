const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'Socket', 'messages-send.js'),
    'utf8'
)

describe('username-only message routing', () => {
    test('uses the peer recipient username attribute for LID delivery', () => {
        expect(source).toContain('peer_recipient_username: normalizedUsername')

        const candidateStart = source.indexOf('const candidateIsLid')
        const candidateBlock = source.slice(
            candidateStart,
            source.indexOf('const sent = await messagesSocket.sendMessage', candidateStart)
        )
        expect(candidateBlock).not.toMatch(/(^|[\s,{])recipient_username\s*:/m)
    })

    test('routes composed rich messages through username target resolution', () => {
        expect(source).toContain('const resolveComposedMessageTarget')
        expect(source).toContain('const relayComposedMessage')

        for (const helper of [
            'sendTable',
            'sendList',
            'sendCodeBlock',
            'sendLatex',
            'sendLatexImage',
            'sendLatexInlineImage',
            'sendUnifiedResponse',
            'sendRichMessage'
        ]) {
            expect(source).toMatch(new RegExp(`${helper}:[\\s\\S]*?return relayComposedMessage\\(`))
        }
    })

    test('relayMessage resolves usernames while preserving the normal JID route', () => {
        expect(source).toContain('const relayMessageWithUsername')
        expect(source).toContain('return relayMessage(target, message, options)')
        expect(source).toContain('const resolved = await resolveComposedMessageTarget(target, options)')
        expect(source).toContain('return relayMessage(resolved.jid, message, {')
        expect(source).toContain('relayMessage: relayMessageWithUsername')

        const wrapperStart = source.indexOf('const relayMessageWithUsername')
        const passthroughRoute = source.indexOf('return relayMessage(target, message, options)', wrapperStart)
        const usernameLookup = source.indexOf('resolveComposedMessageTarget(target, options)', wrapperStart)
        expect(wrapperStart).toBeGreaterThan(-1)
        expect(passthroughRoute).toBeGreaterThan(wrapperStart)
        expect(usernameLookup).toBeGreaterThan(passthroughRoute)
    })

    test('rejects malformed relay recipients before destructuring the decoded JID', () => {
        const relayStart = source.indexOf('const relayMessage = async (jid, message')
        const decode = source.indexOf('const decodedJid = WABinary_1.jidDecode(jid)', relayStart)
        const invalidGuard = source.indexOf("Invalid WhatsApp recipient JID: expected user@server", decode)
        const destructure = source.indexOf('const { user, server } = decodedJid', decode)

        expect(relayStart).toBeGreaterThan(-1)
        expect(source.slice(relayStart, decode)).toContain('} = {}) =>')
        expect(decode).toBeGreaterThan(relayStart)
        expect(invalidGuard).toBeGreaterThan(decode)
        expect(destructure).toBeGreaterThan(invalidGuard)
    })

    test('passes status broadcasts and their phone recipients through unchanged', () => {
        const wrapperStart = source.indexOf('const relayMessageWithUsername')
        const statusGuard = source.indexOf('target === WABinary_1.STORIES_JID', wrapperStart)
        const directRelay = source.indexOf('return relayMessage(target, message, options)', statusGuard)
        const optionResolution = source.indexOf('options = await resolveMessageRecipientOptions(options)', wrapperStart)

        expect(statusGuard).toBeGreaterThan(wrapperStart)
        expect(directRelay).toBeGreaterThan(statusGuard)
        expect(optionResolution).toBeGreaterThan(directRelay)
    })

    test('sendMessage accepts usernames without changing normal JID routing', () => {
        expect(source).toContain("typeof jid === 'string' && jid.trim().startsWith('@')")
        expect(source).toContain('return messagesSocket.sendMessageToUsername(jid, content, options)')

        const sendMessageStart = source.indexOf('sendMessage: async (jid, content, options = {})')
        const usernameRoute = source.indexOf('return messagesSocket.sendMessageToUsername', sendMessageStart)
        const normalRoute = source.indexOf('const userJid = authState.creds.me.id', sendMessageStart)
        expect(sendMessageStart).toBeGreaterThan(-1)
        expect(usernameRoute).toBeGreaterThan(sendMessageStart)
        expect(normalRoute).toBeGreaterThan(usernameRoute)
    })

    test('normalizes raw phone recipients without changing existing JIDs', () => {
        expect(source).toContain('const normalizeDirectRecipientTarget')
        expect(source).toContain("return `${number}@s.whatsapp.net`")
        expect(source).toContain('jid = normalizeDirectRecipientTarget(jid)')
        expect(source).toContain('target = normalizeDirectRecipientTarget(target)')
    })

    test('resolves status viewers and participant recipients through the shared path', () => {
        expect(source).toContain('const resolveMessageRecipientOptions')
        expect(source).toContain('resolveComposedMessageTarget(participant.jid, options)')
        expect(source).toContain('statusJidList.map(async (jid) =>')
        expect(source).toContain('options = await resolveMessageRecipientOptions(options)')
    })

    test('strips invisible bidirectional formatting from copied usernames', () => {
        expect(source).toMatch(/\\u2066-\\u2069/)
    })

    test('routes direct rahmi senders through the shared recipient resolver', () => {
        const dugongSource = fs.readFileSync(
            path.join(__dirname, '..', 'lib', 'Socket', 'dugong.js'),
            'utf8'
        )

        expect(source).toContain('relayMessageWithUsername,')
        expect(source).toContain('async target => (await resolveComposedMessageTarget(target)).jid')
        expect(dugongSource).toContain('this.resolveTarget = typeof resolveTargetFn === "function"')

        for (const helper of [
            'handleAlbum',
            'handleEvent',
            'handlePollResult',
            'handleGroupStory'
        ]) {
            expect(dugongSource).toMatch(new RegExp(`${helper}\\(content, jid, quoted(?:, relayOptions = \\{\\})?\\)[\\s\\S]*?jid = await this\\.resolveTarget\\(jid\\)`))
        }
    })

    test('sendMessage routes table and codeBlock content through their composers', () => {
        const sendMessageStart = source.indexOf('sendMessage: async (jid, content, options = {})')
        const sendMessageBlock = source.slice(sendMessageStart)

        expect(sendMessageBlock).toContain("'table' in content")
        expect(sendMessageBlock).toContain('return messagesSocket.sendTable(')
        expect(sendMessageBlock).toContain("'codeBlock' in content")
        expect(sendMessageBlock).toContain('return messagesSocket.sendCodeBlock(')
    })

    test('resolves the recipient before regular and custom message type dispatch', () => {
        const sendMessageStart = source.indexOf('sendMessage: async (jid, content, options = {})')
        const normalizeTarget = source.indexOf('jid = normalizeDirectRecipientTarget(jid)', sendMessageStart)
        const usernameRoute = source.indexOf('return messagesSocket.sendMessageToUsername(jid, content, options)', sendMessageStart)
        const customTypeDispatch = source.indexOf('const messageType = rahmi.detectType(content)', sendMessageStart)
        const regularMessageBuilder = source.indexOf('Utils_1.generateWAMessage(jid, content', sendMessageStart)

        expect(normalizeTarget).toBeGreaterThan(sendMessageStart)
        expect(usernameRoute).toBeGreaterThan(normalizeTarget)
        expect(customTypeDispatch).toBeGreaterThan(usernameRoute)
        expect(regularMessageBuilder).toBeGreaterThan(customTypeDispatch)
    })

    test('preserves username routing options for every custom message type', () => {
        const dugongSource = fs.readFileSync(
            path.join(__dirname, '..', 'lib', 'Socket', 'dugong.js'),
            'utf8'
        )

        for (const type of ['PAYMENT', 'PRODUCT', 'INTERACTIVE']) {
            const caseStart = source.indexOf(`case '${type}':`)
            const caseEnd = source.indexOf('case ', caseStart + 6)
            const caseBlock = source.slice(caseStart, caseEnd)
            expect(caseBlock).toContain('...options')
        }

        for (const helper of [
            'handleAlbum',
            'handleEvent',
            'handlePollResult',
            'handleGroupStory'
        ]) {
            expect(source).toContain(`rahmi.${helper}(content, jid, quoted, options)`)
            expect(dugongSource).toMatch(new RegExp(
                `async ${helper}\\(content, jid, quoted, relayOptions = \\{\\}\\)[\\s\\S]*?this\\.relayMessage\\(jid, [\\s\\S]*?\\{[\\s\\S]*?\\.\\.\\.relayOptions,[\\s\\S]*?messageId:`
            ))
        }
    })
})
