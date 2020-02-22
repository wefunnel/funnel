const net = require('net')

const remoteHost = '172.98.67.83'
const remotePort = 502

let remoteSocket

const server = net.createServer((c) => {
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
      host: remoteHost,
      port: remotePort,
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

server.on('error', (err) => {
  console.log('Server threw error', err)
})

const port = 9365
server.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})
