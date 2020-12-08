const fetch = require("node-fetch")
const { v4: uuidv4 } = require('uuid');
const { diff } = require('deep-object-diff')
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const WebSocketClient = require('websocket').client;

class App {
    constructor(jvbBaseUrl, rtcStatsServerUrl) {
        this.jvbUrl = `${jvbBaseUrl}/debug?full=true`;
        this.rtcStatsServerUrl = rtcStatsServerUrl;
        console.log(`Querying JVB REST API at ${this.jvbUrl}`);
        console.log(`Sending stats data to RTC stats server at ${this.rtcStatsServerUrl}`);

        // Map conference ID to state about that conference
        // Conference state contains, at least:
        // dumpId: (String) the dump ID for this conference
        // endpoints: (Array) endpoint stat IDs for all endpoints *who have ever* been in this conference
        // previous_debug_data: (Object) the previous debug data from the last request (used for diffing)
        this.conferenceStates = {};
    }

    async start() {
        try {
            this.ws = await setupWebsocket(this.rtcStatsServerUrl);
        } catch (err) {
            console.error(`Error connecting to RTC stats server: ${err.toString()}`);
            return;
        }
        this.fetchTask = setInterval(async () => {
            console.log("Fetching data");
            const json = await fetchJson(this.jvbUrl);
            this.processJvbJson(json);
        }, 5000);
    }

    stop() {
        clearInterval(this.fetchTask);
    }

    processJvbJson(jvbJson) {
        this.checkForAddedOrRemovedConferences(jvbJson);
        const timestamp = jvbJson["time"]
        Object.keys(jvbJson["conferences"]).forEach(confId => {
            const confData = jvbJson["conferences"][confId];
            // The timestamp is at the top level, inject it into the conference data here
            confData["timestamp"] = timestamp;
            this.processConference(confId, jvbJson["conferences"][confId]);
        });
    }

    checkForAddedOrRemovedConferences(jvbJson) {
        const confIds = getConferenceIds(jvbJson);
        const newConfIds = confIds.filter(id => !(id in this.conferenceStates));
        const removedConfIds = Object.keys(this.conferenceStates).filter(id => confIds.indexOf(id) === -1)
        newConfIds.forEach(newConfId => {
            const dumpId = uuidv4();
            const confState = {
                dumpId,
                // TODO: use a set?
                endpoints: []
            }
            this.conferenceStates[newConfId] = confState;
            this.sendData(createIdentityMessage(confState));
        });
        removedConfIds.forEach(removedConfId => {
            const confState = this.conferenceStates[removedConfId];
            delete this.conferenceStates[removedConfId];
            this.sendData(createCloseMsg(confState["dumpId"]))
        });
    }

    processConference(confId, confData) {
        this.checkForAddedOrRemovedEndpoints(confId, confData["endpoints"]);
        const previousData = this.conferenceStates[confId]["previous_debug_data"] || {};
        const statDiff = diff(previousData, confData);
        this.sendData(createStatEntryMessage(this.conferenceStates[confId].dumpId, statDiff));
        this.conferenceStates[confId]["previous_debug_data"] = confData;
    }

    checkForAddedOrRemovedEndpoints(confId, currentConfEndpoints) {
        const confState = this.conferenceStates[confId];
        const knownConfEps = confState["endpoints"];
        const epStatsIds = Object.keys(currentConfEndpoints)
            .map(epId => currentConfEndpoints[epId]["statsId"]);
        const newEndpoints = epStatsIds.filter(epStatsId => knownConfEps.indexOf(epStatsId) === -1);
        if (newEndpoints.length > 0) {
            confState["endpoints"].push(...newEndpoints);
            this.sendData(createIdentityMessage(confState));
        }
    }

    sendData(msgObj) {
        this.ws.send(JSON.stringify(msgObj));
    }
}

const params = yargs(hideBin(process.argv))
    .options({
        "jvb-address": {
            alias: "j",
            describe: "The address of the JVB whose REST API will be queried ('http://127.0.0.1:8080')",
            demandOption: true
        },
        "rtcstats-server": {
            alias: "r",
            describe: "The address of the RTC stats server websocket ('ws://127.0.0.1:3000')",
            demandOption: true
        }

    })
    .help()
    .argv

const app = new App(params.jvbAddress, params.rtcstatsServer);

app.start();

/**
 * Given the data retrieved from the JVB REST API,
 * extract all of the conference IDs
 * @param jvbJson
 */
function getConferenceIds(jvbJson) {
    return Object.keys(jvbJson.conferences);
}

async function fetchJson(url) {
    try {
        const response = await fetch(url)
        return await response.json();
    } catch (e) {
        console.log("Error retrieving data: ", e);
        return null
    }
}

function createIdentityMessage(state) {
    // This is a bit awkward: we keep the dumpId in the conference state,
    // but we need to set it as an explicit field of the message.  Also,
    // we need to explicit parse out previous_debug_data so that we can
    // not include it in the message
    const {dumpId, previous_debug_data, ...metadata} = state;
    return {
        type: "identity",
        dumpId,
        data: JSON.stringify(metadata)
    }
}

function createCloseMsg(dumpId) {
    return {
        type: "close",
        dumpId
    }
}

function createStatEntryMessage(dumpId, data) {
    return {
        type: "stats-entry",
        dumpId,
        data: JSON.stringify(data)
    }
}

function setupWebsocket(url) {
    return new Promise(((resolve, reject) => {
        const client = new WebSocketClient();
        client.on('connectFailed', reject);
        // Handle issues with the connection after it's connected
        client.on('connect', resolve);
        client.connect(url, "rtcstats");
    }))
}

