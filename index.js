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
const axios = require('axios')
const net = require('net')
const _ = require('lodash')

const rpc = new JsonRpc(process.env.EOS_RPC_URL, { fetch })
const api = new Api({
  rpc,
  signatureProvider,
  textDecoder: new TextDecoder(),
  textEncoder: new TextEncoder(),
})

let tcpRoutes = []
const connectionsByRouteId = {}

const funnelServer = net.createServer((c) => {
  const route = tcpRoutes.find(({ incoming }) => {
    return c.remoteAddress.indexOf(incoming) !== -1
  })
  if (!route) {
    return c.destroy()
  }
  console.log(`TCP Connection ${route.client} -> ${route.outgoing}`)
  let remoteSocket = connectionsByRouteId[route.id]
  if (!remoteSocket) {
    remoteSocket = new net.Socket({
      writable: true,
      readable: true,
    })
    remoteSocket.setKeepAlive(true)
    remoteSocket.connect({
      host: route.outgoing.split(':')[0],
      port: route.outgoing.split(':')[1]
    })
    connectionsByRouteId[route.id] = [ remoteSocket ]
    remoteSocket.on('close', () => {
      remoteSocket.destroy()
      if (_.get(connectionsByRouteId, '[0]') === remoteSocket) {
        for (const connection of connectionsByRouteId[route.id]) {
          connection.destroy()
        }
        delete connectionsByRouteId[route.id]
      }
    })
  }
  c.pipe(remoteSocket)
  remoteSocket.pipe(c)
  c.on('end', () => {
    remoteSocket.close()
  })
})

funnelServer.on('error', (err) => {
  console.log('Server threw error', err)
})

const port = 9365
funnelServer.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})

/**
 * rate: number
 * funnel_uri_enc: string
 * target_uri_enc: string
 * active: number
 * client: string
 **/

function decryptData(publicKey, data) {
  const { nonce, message, checksum } = JSON.parse(data)
  return Aes.decrypt(
    process.env.EOS_PRIVATE_KEY,
    publicKey.toString(),
    new Long(nonce.low, nonce.high, nonce.unsigned),
    Buffer.from(message, 'base64'),
    checksum
  ).toString()
}

/**
 * Main event loop
 **/
;(async () => {
  let funnel
  let cycleFailures = 0
  const { data: { ip } } = await axios('https://external-ip.now.sh')
  for (;;) {
    try {
      funnel = await createOrUpdateFunnel()
      const newRoutes = await loadRoutes()
      const newRoutesById = _.keyBy(newRoutes, 'id')
      const existingRoutesById = _.keyBy(tcpRoutes, 'id')
      for (const oldRoute of tcpRoutes) {
        if (newRoutesById[oldRoute.id]) continue // No change
        // Otherwise remove, kill TCP sockets
        if (!connectionsByRouteId[oldRoute.id]) continue
        connectionsByRouteId[oldRoute.id].map(
          (connection) => connection.close()
        )
      }
      for (const newRoute of newRoutes) {
        if (existingRoutesById[newRoute.id]) continue // No change
        // Otherwise post encrypted connection info
        if (!newRoute.funnel_uri_enc) {
          await setFunnelUri(newRoute.client, `${ip}:${port}`)
        }
      }
      tcpRoutes = newRoutes
      console.log('Waiting to update...')
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

/**
 * Load funnel state from blockchain every 2 seconds
 **/
async function createOrUpdateFunnel(_funnel) {
  try {
    const { rows } = await rpc.get_table_rows({
      json: true,
      code: process.env.EOS_CONTRACT_NAME,
      scope: process.env.EOS_CONTRACT_NAME,
      table: 'funnels',
      limit: 1,
      lower_bound: process.env.EOS_USERNAME,
    })
    if (rows.length === 0) {
      // funnel does not exist
      await api.transact({
        actions: [{
          account: process.env.EOS_CONTRACT_NAME,
          name: 'createfunnel',
          authorization: [{
            actor: process.env.EOS_USERNAME,
            permission: 'active',
          }],
          data: {
            owner: process.env.EOS_USERNAME,
            rate: 10,
            slots: 16,
          }
        }]
      }, {
        blocksBehind: 3,
        expireSeconds: 30,
      })
      return await createOrUpdateFunnel()
    }
    const [ funnel ] = rows
    const funnelEmitter = _funnel || new EventEmitter()
    Object.assign(funnelEmitter, funnel)
    funnelEmitter.emit('update', funnelEmitter)
    return funnelEmitter
  } catch (err) {
    console.log('Error getting funnel ', err)
    throw err
  }
}

async function loadRoutes() {
  const _loadRoutes = async () => await rpc.get_table_rows({
    json: true,
    code: process.env.EOS_CONTRACT_NAME,
    scope: process.env.EOS_CONTRACT_NAME,
    table: 'routes',
    limit: 20,
    index_position: 'fourth',
    key_type: 'i64',
    upper_bound: process.env.EOS_USERNAME,
    lower_bound: process.env.EOS_USERNAME,
  })
  const routes = []
  let more = true
  while (more) {
    const { rows, more: _more } = await _loadRoutes()
    routes.push(...rows)
    more = _more
  }
  // For each one decrypt the incoming and outgoing uris
  return await Promise.all(routes.map(async (route) => {
    const publicKey = await clientPublicKey(route.client)
    let incoming, outgoing
    if (route.incoming_uri_enc) {
      incoming = decryptData(publicKey, route.incoming_uri_enc)
    }
    if (route.outgoing_uri_enc) {
      outgoing = decryptData(publicKey, route.outgoing_uri_enc)
    }
    return { ...route, incoming, outgoing }
  }))
}

async function clientPublicKey(username) {
  const { permissions } = await rpc.get_account(username)
  const ownerPerm = permissions.find((perm) => perm.perm_name === 'owner')
  return PublicKey(ownerPerm.required_auth.keys[0].key)
}

async function setFunnelUri(client, uri) {
  const public = await clientPublicKey(client)
  const { nonce, message, checksum } = Aes.encrypt(
    process.env.EOS_PRIVATE_KEY,
    public,
    uri
  )
  const uri_enc = JSON.stringify({
    nonce,
    checksum,
    message: message.toString('base64'),
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
        owner: process.env.EOS_USERNAME,
        client,
        uri: uri_enc,
      }
    }]
  }, {
    blocksBehind: 3,
    expireSeconds: 30,
  })
}
