const test = require('node:test')
const assert = require('node:assert/strict')
const { privateMessage } = require('../dist/bin/qq')
test('QQ only admits human private text, reads the documented message index and preserves the reply id', () => {
  const d = { author: { user_openid: 'owner' }, id: 'reply-target', content: '  hello ', message_type: 0, message_scene: { ext: ['ref_msg_idx=other', 'msg_idx=index=='] } }
  const frame = { op: 0, t: 'C2C_MESSAGE_CREATE', d }
  assert.deepEqual(privateMessage(frame), { sender: 'owner', id: 'reply-target', index: 'index==', text: 'hello' })
  assert.equal(privateMessage({ ...frame, t: 'GROUP_AT_MESSAGE_CREATE' }), undefined)
  assert.equal(privateMessage({ ...frame, d: { ...d, message_type: 3 } }), undefined)
  assert.equal(privateMessage({ ...frame, d: { ...d, author: {} } }), undefined)
  assert.equal(privateMessage({ ...frame, d: { ...d, message_scene: {} } }).index, 'reply-target')
})
