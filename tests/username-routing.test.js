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
            source.indexOf('const sent = await this.sendMessage', candidateStart)
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
})
