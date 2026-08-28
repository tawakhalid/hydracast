/**
 * Test double for "a streaming platform": a standalone RTMP server that accepts
 * one publish and prints the bitrate it is receiving, once per second.
 * Runs in its own process because node-media-server keeps global session state.
 */
const NodeMediaServer = require('node-media-server')

const port = Number(process.argv[2] || 11936)
const nms = new NodeMediaServer({
  logType: 0,
  rtmp: { port, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 }
})

let sessionId = null
nms.on('postPublish', (id, streamPath) => {
  sessionId = id
  console.log(`publish ${streamPath}`)
})
nms.on('donePublish', () => {
  sessionId = null
})

nms.run()
console.log(`listening ${port}`)

setInterval(() => {
  if (!sessionId) return
  const s = nms.getSession(sessionId)
  if (s) console.log(`bitrate ${Math.round(s.bitrate || 0)} ${s.videoWidth}x${s.videoHeight}`)
}, 1000)
