const fetch = require('node-fetch')
const JvbLogTail = require('./JvbLogTail.js')
const { v4: uuidv4 } = require('uuid')
const { diff } = require('deep-object-diff')
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const WebSocketClient = require('websocket').client
const os = require('os')
require('log-timestamp')

class App {
  constructor (jvbUrl, rtcStatsServerUrl, jvbLogFilePath) {
    this.jvbUrl = jvbUrl
    this.rtcStatsServerUrl = rtcStatsServerUrl
    this.jvbLogFilePath = jvbLogFilePath
    console.log(`Querying JVB REST API at ${this.jvbUrl}`)
    console.log(`Sending stats data to RTC stats server at ${this.rtcStatsServerUrl}`)

    // Map conference ID to state about that conference
    // Conference state contains, at least:
    // statsSessionId: (String) the dump ID for this conference
    // endpoints: (Array) endpoint stat IDs for all endpoints *who have ever* been in this conference
    // previousDebugData: (Object) the previous debug data from the last request (used for diffing)
    this.conferenceStates = {}
  }

  start () {
    this.setupWebsocket()
    if (this.jvbLogFilePath) {
      console.log(`Reading JVB logs from ${this.jvbLogFilePath}.`)
      this.tail = new JvbLogTail(this.jvbLogFilePath)
    }
    this.fetchTask = setInterval(async () => {
      const json = await fetchJson(this.jvbUrl)
      this.processJvbJson(json)
    }, 5000)
  }

  stop () {
    clearInterval(this.fetchTask)
  }

  setupWebsocket () {
    // Create the websocket client
    this.wsClient = new WebSocketClient({
      keepalive: true,
      keepaliveInterval: 20000
    })
    // Enclose the websocket connect logic so it can be re-used easily in the reconnect logic below.
    const wsConnectionFunction = () => {
      console.log('Connecting websocket')
      const displayName = process.env.JVB_MUC_NICKNAME ?? os.hostname()
      this.wsClient.connect(
        this.rtcStatsServerUrl,
        '3.0_JVB',
        displayName,
        { 'User-Agent': `Node ${process.version}` }
      )
    }

    // Install the event handlers on the websocket client
    this.wsClient.on('connectFailed', error => {
      console.log('Websocket connection failed: ', error)
      console.log('Will try to reconnect in 5 seconds')
      setTimeout(wsConnectionFunction, 5000)
    })

    this.wsClient.on('connect', connection => {
      // Assign the new connection to a member so it can be used to send data
      this.ws = connection
      console.log('Websocket connected')

      // Install the event handlers on the connection object
      connection.on('error', error => {
        console.log('Websocket error: ', error)
      })

      connection.on('close', () => {
        console.log('Websocket closed, will try to reconnect in 5 seconds')
        setTimeout(wsConnectionFunction, 5000)
      })
    })

    // Do the initial connection
    wsConnectionFunction()
  }

  processJvbJson (jvbJson) {
    this.checkForAddedOrRemovedConferences(jvbJson)
    const timestamp = jvbJson.time
    getConferenceIds(jvbJson).forEach(confId => {
      const confData = jvbJson.conferences[confId]
      // The timestamp is at the top level, inject it into the conference data here
      confData.timestamp = timestamp
      this.processConference(confId, jvbJson.conferences[confId])
    })
  }

  checkForAddedOrRemovedConferences (jvbJson) {
    const displayName = process.env.JVB_MUC_NICKNAME ?? os.hostname()
    const confIds = getConferenceIds(jvbJson)
    const newConfIds = confIds.filter(id => !(id in this.conferenceStates))
    const removedConfIds = Object.keys(this.conferenceStates).filter(id => confIds.indexOf(id) === -1)
    newConfIds.forEach(newConfId => {
      const statsSessionId = uuidv4()
      const confState = {
        statsSessionId,
        confName: extractConferenceName(jvbJson, newConfId),
        displayName,
        meetingUniqueId: extractUniqueMeetingId(jvbJson, newConfId) || newConfId,
        applicationName: 'JVB',
        endpoints: []
      }
      this.conferenceStates[newConfId] = confState
      this.sendData(createIdentityMessage(confState))
    })
    removedConfIds.forEach(removedConfId => {
      const confState = this.conferenceStates[removedConfId]
      delete this.conferenceStates[removedConfId]
      this.sendData(createCloseMsg(confState.statsSessionId))
    })
  }

  processConference (confId, confData) {
    this.checkForAddedOrRemovedEndpoints(confId, confData.endpoints)
    const previousData = this.conferenceStates[confId].previousDebugData || {}
    const statDiff = diff(previousData, confData)
    const statsSessionId = this.conferenceStates[confId].statsSessionId
    this.sendData(createStatEntryMessage(statsSessionId, statDiff))
    this.conferenceStates[confId].previousDebugData = confData

    if (this.tail) {
      const logs = this.tail.getLogs(this.conferenceStates[confId].meetingUniqueId)
      if (logs && logs.length) {
        this.sendData(createStatEntryLogMessage(statsSessionId, logs))
      }
    }
  }

  checkForAddedOrRemovedEndpoints (confId, currentConfEndpoints) {
    const confState = this.conferenceStates[confId]
    const knownConfEps = confState.endpoints
    const epStatsIds = Object.keys(currentConfEndpoints)
      .map(epId => currentConfEndpoints[epId].statsId)
    const newEndpoints = epStatsIds.filter(epStatsId => knownConfEps.indexOf(epStatsId) === -1)
    if (newEndpoints.length > 0) {
      confState.endpoints.push(...newEndpoints)
      this.sendData(createIdentityMessage(confState))
    }
  }

  sendData (msgObj) {
    this.ws.send(JSON.stringify(msgObj))
  }
}

const params = yargs(hideBin(process.argv))
  .env()
  .options({
    'jvb-address': {
      alias: 'j',
      describe: "The address of the JVB whose REST API will be queried ('http://127.0.0.1:8080')",
      demandOption: true
    },
    'rtcstats-server': {
      alias: 'r',
      describe: "The address of the RTC stats server websocket ('ws://127.0.0.1:3000')",
      demandOption: true
    },
    'jvb-log-file': {
      alias: 'l',
      describe: 'The path to the JVB log file to tail.',
      demandOption: false
    },
    'jvb-path': {
      describe: 'The path of the HTTP endpoint to query.',
      default: 'stats'
    }
  })
  .help()
  .argv

console.log(`Using jvb address ${params.jvbAddress}, jvb log file ${params.jvbLogFile}, and rtcstats server ${params.rtcstatsServer}.`)

const app = new App(`${params.jvbAddress}/${params.jvbPath}`, params.rtcstatsServer, params.jvbLogFile)

app.start()

/**
 * Given the data retrieved from the JVB REST API,
 * extract all of the conference IDs
 * @param jvbJson
 */
function getConferenceIds (jvbJson) {
  // only report conferences that have rtcstats enabled. Note that we include conferences that don't have the
  // rtcstatsEnabled flag set in order to maintain backwards compatibility with bridges that don't support this
  // new flag.
  // We also filter out conferences that don't have the name set. In practice this just ignores conferences
  // created with REST to make sure the JVB IP has been initialized.
  return Object.keys(jvbJson.conferences)
    .filter(confId => {
      const conf = jvbJson.conferences[confId]
      return (conf.rtcstatsEnabled === undefined || conf.rtcstatsEnabled) && conf.name
    })
}

async function fetchJson (url) {
  try {
    const response = await fetch(url)
    return await response.json()
  } catch (e) {
    console.log('Error retrieving data: ', e)
    return null
  }
}

function extractConferenceName (jvbJson, confId) {
  return jvbJson.conferences[confId].name.split('@')[0]
}

function extractUniqueMeetingId (jvbJson, confId) {
  return jvbJson.conferences[confId].meeting_id
}

function createIdentityMessage (state) {
  // This is a bit awkward: we keep the statsSessionId in the conference state,
  // but we need to set it as an explicit field of the message.  Also,
  // we need to explicit parse out previousDebugData so that we can
  // not include it in the message
  const { statsSessionId, previousDebugData, ...metadata } = state
  return {
    type: 'identity',
    statsSessionId,
    data: metadata
  }
}

function createCloseMsg (statsSessionId) {
  return {
    type: 'close',
    statsSessionId
  }
}

/** Create a stats-entry message that includes logs. */
function createStatEntryLogMessage (statsSessionId, logLines) {
  const data = [
    'logs',
    null,
    logLines.map(line => {
      return { text: line, count: 1 }
    }),
    Date.now()
  ]

  return {
    type: 'stats-entry',
    statsSessionId,
    data: JSON.stringify(data)
  }
}

function createStatEntryMessage (statsSessionId, data) {
  return {
    type: 'stats-entry',
    statsSessionId,
    data: JSON.stringify(data)
  }
}
