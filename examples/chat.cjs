const { initializeFamilaCore } = require('../dist')

async function main() {
  const core = await initializeFamilaCore({ dataDirectory: './.famila' })
  try {
    await core.chat.sendStreamMessage({ text: process.argv[2] || '你好，法弥拉。' }, chunk => console.log(chunk))
  } finally {
    await core.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
