<div align="center">
  <h1>wolf-baileys</h1>
  
  <p>
    <strong>Join the community & stay updated</strong><br>
    <br>
    <a href="https://t.me/+6FGiKJQ4TXdjZTA9" target="_blank">
      <img src="https://img.shields.io/badge/Telegram-Group-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white&labelColor=10151a" alt="Telegram Group">
    </a>
    <a href="https://t.me/WOLFBUGS" target="_blank">
      <img src="https://img.shields.io/badge/Telegram-Channel-26A5E4?style=for-the-badge&logo=telegram&logoColor=white&labelColor=0f1621" alt="Telegram Channel">
    </a>
    &nbsp;&nbsp;
    <a href="https://whatsapp.com/channel/0029Vb81WoKJUM2dMVJmRA2L" target="_blank">
      <img src="https://img.shields.io/badge/WhatsApp-Channel-25D366?style=for-the-badge&logo=whatsapp&logoColor=white&labelColor=0f3f30" alt="WhatsApp Channel">
    </a>
  </p>

  <br>
  	
</div>

<br>

## Sending by phone number or username

Both addressing modes can be used independently. Phone-number sending keeps the normal Baileys JID format, while username sending only needs the WhatsApp `@username` and does not require knowing the recipient's number.

```js
// Send by phone number
await sock.sendMessage('201501037773@s.whatsapp.net', {
  text: 'رسالة بالرقم'
})

// Send using only a WhatsApp username
await sock.sendMessageToUsername('@Midoxsmb', {
  text: 'رسالة بالـusername فقط'
})

// sendMessage accepts either a JID or @username
await sock.sendMessage('@Midoxsmb', {
  text: 'Message sent with the unified API'
})

// Custom rich content is also available through sendMessage
await sock.sendMessage('@Midoxsmb', {
  table: {
    title: 'WOLF Status',
    headers: ['Status', 'Feature'],
    rows: [['OK', 'Unified sendMessage']]
  }
})

await sock.sendMessage('@RTX.11', {
  codeBlock: {
    code: 'function wolf() { return true }',
    language: 'javascript'
  }
})

// relayMessage also resolves @username before relaying prepared content
await sock.relayMessage('@Midoxsmb', preparedMessage, {
  messageId: 'CUSTOM_MESSAGE_ID'
})

// Rich helpers also accept @username directly
await sock.sendTable('@Midoxsmb', 'WOLF Status', ['Status', 'Feature'], [
  ['OK', 'sendRichMessage'],
  ['OK', 'sendCodeBlock']
])

await sock.sendCodeBlock(
  '@RTX.11',
  'function wolf() { return true }',
  undefined,
  { language: 'javascript' }
)
```
