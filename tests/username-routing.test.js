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
        expect(source).toContain('? { ...options.participant, jid: resolved.jid }')
        expect(source).toContain('return relayMessage(resolved.jid, message, {')
        expect(source).toContain('relayMessage: relayMessageWithUsername')

        const wrapperStart = source.indexOf('const relayMessageWithUsername')
        const passthroughRoute = source.indexOf('return relayMessage(target, message, options)', wrapperStart)
        const usernameLookup = source.indexOf('resolveComposedMessageTarget(target, options)', wrapperStart)
        expect(wrapperStart).toBeGreaterThan(-1)
        expect(passthroughRoute).toBeGreaterThan(wrapperStart)
        expect(usernameLookup).toBeGreaterThan(passthroughRoute)
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

    test('sendMessage routes table and codeBlock content through their composers', () => {
        const sendMessageStart = source.indexOf('sendMessage: async (jid, content, options = {})')
        const sendMessageBlock = source.slice(sendMessageStart)

        expect(sendMessageBlock).toContain("'table' in content")
        expect(sendMessageBlock).toContain('return messagesSocket.sendTable(')
        expect(sendMessageBlock).toContain("'codeBlock' in content")
        expect(sendMessageBlock).toContain('return messagesSocket.sendCodeBlock(')
    })
})
