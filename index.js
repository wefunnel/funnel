require('dotenv').config()
const eosjs = require('eosjs')
const { Api, JsonRpc, RpcError } = eosjs
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig')
const signatureProvider = new JsSignatureProvider([process.env.EOS_PRIVATE_KEY])
const { TextEncoder, TextDecoder } = require('util')
const { spawn, fork } = require('child_process')
const path = require('path')
const { EventEmitter } = require('events')
const fetch = require('node-fetch')
const { Aes, PublicKey, ...ecc} = require('eosjs-ecc')
const { Long } = require('bytebuffer')

const rpc = new JsonRpc(process.env.EOS_RPC_URL, { fetch })
const api = new Api({
  rpc,
  signatureProvider,
  textDecoder: new TextDecoder(),
  textEncoder: new TextEncoder(),
})

/**
 * rate: number
 * funnel_uri_enc: string
 * target_uri_enc: string
 * active: number
 * client: string
 **/

;(async () => {
  let funnel
  let cycleFailures = 0
  for (;;) {
    try {
      funnel = await updateFunnel(funnel)
      if (!funnel.active) {
        await new Promise(r => setTimeout(r, 5000))
        continue
      }
      if (funnel.active && funnel.incoming_uri_enc && funnel.outgoing_uri_enc) {
        // Once this is done, upload funnel_uri_enc
        const publicKey = await clientPublicKey(funnel)
        let incomingUri, outgoingUri
        {
          const { nonce, message, checksum } = JSON.parse(funnel.incoming_uri_enc)
          incomingUri = Aes.decrypt(
            process.env.EOS_PRIVATE_KEY,
            publicKey.toString(),
            new Long(nonce.low, nonce.high, nonce.unsigned),
            Buffer.from(message, 'base64'),
            checksum
          ).toString()
        }
        {
          const { nonce, message, checksum } = JSON.parse(funnel.outgoing_uri_enc)
          outgoingUri = Aes.decrypt(
            process.env.EOS_PRIVATE_KEY,
            publicKey.toString(),
            new Long(nonce.low, nonce.high, nonce.unsigned),
            Buffer.from(message, 'base64'),
            checksum
          ).toString()
        }
        // Successfully decrypted incoming and outgoing uris
        console.log(incomingUri, outgoingUri)
        await setFunnelUri(funnel, 'http://192.168.1.3:9365')
        funnel.addListener('update', onUpdate)
        funnel.process = startFunnel(incomingUri, outgoingUri)
        await exitWait(funnel.process)
        // Loop continues when process exits, prepare to discard local variables
        funnel.removeListener('update', onUpdate)
        continue
      }
      await new Promise(r => setTimeout(r, 4000))
    } catch (err) {
      console.log('Uncaught error', err)
      if (cycleFailures++ >= 5) {
        console.log('5 uncaught errors, exiting')
        process.exit(1)
      }
      await new Promise(r => setTimeout(r, 5000))
    }
  }
})()

function startFunnel(...args) {
  const p = fork(path.join(__dirname, './funnel.js'), args, {
    cwd: __dirname,
    detached: false,
    stdio: [
      0,
      'pipe',
      'pipe',
      'ipc',
    ]
  })
  p.stdout.on('data', (b) => console.log(b.toString()))
  p.stderr.on('data', (b) => console.log('Error: ', b.toString()))
  return p
}

async function onUpdate(funnel) {
  console.log('funnel updated')
  // If funnel changes modify state
  if (!funnel.active) {
    await exitWait(funnel.process)
  }
}

/**
 * Load funnel state from blockchain every 2 seconds
 **/
async function updateFunnel(_funnel) {
  try {
    const { rows } = await rpc.get_table_rows({
      json: true,
      code: process.env.EOS_CONTRACT_NAME,
      scope: process.env.EOS_CONTRACT_NAME,
      table: 'funnels',
      limit: 1,
      lower_bound: process.env.EOS_USERNAME,
    })
    const [ funnel ] = rows
    const funnelEmitter = _funnel || new EventEmitter()
    Object.assign(funnelEmitter, funnel)
    funnelEmitter.emit('update', funnel)
    return funnelEmitter
  } catch (err) {
    console.log('Error getting funnel ', err)
    throw err
  }
}

async function clientPublicKey(funnel) {
  const { permissions } = await rpc.get_account(funnel.client)
  const ownerPerm = permissions.find((perm) => perm.perm_name === 'owner')
  return PublicKey(ownerPerm.required_auth.keys[0].key)
}

async function setFunnelUri(funnel, uri) {
  const public = await clientPublicKey(funnel)
  const { nonce, message, checksum } = Aes.encrypt(
    process.env.EOS_PRIVATE_KEY,
    public,
    uri
  )
  const uri_enc = JSON.stringify({
    nonce,
    checksum,
    message: message.toString(),
  })
  const result = await api.transact({
    actions: [{
      account: process.env.EOS_CONTRACT_NAME,
      name: 'setfunneluri',
      authorization: [{
        actor: process.env.EOS_USERNAME,
        permission: 'active',
      }],
      data: {
        username: process.env.EOS_USERNAME,
        uri: uri_enc,
      }
    }]
  }, {
    blocksBehind: 3,
    expireSeconds: 30,
  })
  // console.log(result)
}

async function exitWait(p) {
  await new Promise((rs, rj) => {
    p.on('exit', (code) => {
      if (code !== null && code !== 0) rj()
      else rs()
    })
  })
}
