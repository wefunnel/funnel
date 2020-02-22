const net = require('net')
const { URL } = require('url')

let remoteSocket

const [,,incomingIp, outgoingUri] = process.argv
if (net.isIP(incomingIp) === 0) {
  console.log('Incoming IP is invalid')
  process.exit(1)
}
const [outgoingHost, outgoingPort] = outgoingUri.split(':')

const funnelServer = net.createServer((c) => {
  if (c.remoteAddress.indexOf(incomingIp) === -1) {
    return c.destroy()
  }
  // c.setKeepAlive(true)
  console.log('TCP connection received')
  if (!remoteSocket) {
    remoteSocket = new net.Socket({
      writable: true,
      readable: true,
      allowHalfOpen: true,
    })
    remoteSocket.setKeepAlive(true)
    remoteSocket.connect({
      host: outgoingHost,
      port: outgoingPort,
    })
    remoteSocket.on('close', () => {
      remoteSocket.destroy()
      remoteSocket = undefined
    })
  }
  const checkInterval = 200
  // 0.5 MB/ms megabytes per millisecond
  const rateLimit = 512 * 1024 / 1000
  let sentLength = 1
  let lastCheck = +new Date() - checkInterval
  process.nextTick(async () => {
    for (;;) {
      const time = +new Date() - lastCheck
      const rate = sentLength / time
      sentLength = 0
      lastCheck = +new Date()
      // console.log(rate)
      if (rate > rateLimit) {
        const pauseTimeNeeded = (rate - rateLimit)/rateLimit*checkInterval
        c.pause()
        remoteSocket.pause()
        console.log('waiting ', pauseTimeNeeded/1000, ' seconds')
        await new Promise(r => setTimeout(r, pauseTimeNeeded))
        c.resume()
        remoteSocket.resume()
      }
      await new Promise(r => setTimeout(r, checkInterval))
    }
  })
  c.on('data', (data) => {
    sentLength += Buffer.byteLength(data)
  })
  remoteSocket.on('data', (data) => {
    sentLength += Buffer.byteLength(data)
  })
  c.pipe(remoteSocket)
  remoteSocket.pipe(c)
  c.on('end', () => {
    console.log('TCP disconnection')
    // Kill this server fork spawning a new one
    process.exit(0)
  })
})

funnelServer.on('error', (err) => {
  console.log('Server threw error', err)
})

const port = 9365
funnelServer.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})
