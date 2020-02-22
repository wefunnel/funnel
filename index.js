require('dotenv').config()
const eosjs = require('eosjs')
const { Api, JsonRpc, RpcError } = eosjs
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig')
const { TextEncoder, TextDecoder } = require('util')
const { spawn, fork } = require('child_process')
const path = require('path')

const signatureProvider = new JsSignatureProvider([process.env.EOS_PRIVATE_KEY])
const rpc = new JsonRpc(process.env.EOS_RPC_URL)
const api = new Api({
  rpc,
  signatureProvider,
  textDecoder: new TextDecoder(),
  textEncoder: new TextEncoder(),
})

;(async () => {
  for (;;) {
    const server = fork(path.join(__dirname, 'server.js'), [], {
      cwd: __dirname,
      detached: false,
      stdio: [
        0,
        'pipe',
        'pipe',
        'ipc',
      ]
    })
    server.stdout.on('data', (b) => console.log(b.toString()))
    server.stderr.on('data', (b) => console.log('Error: ', b.toString()))
    await exitWait(server)
  }
})()

async function exitWait(p) {
  await new Promise((rs, rj) => {
    p.on('exit', (code) => {
      if (code !== null && code !== 0) rj()
      else rs()
    })
  })
}
