const fetch = require("node-fetch")
const { v4: uuidv4 } = require('uuid');
const { diff } = require('deep-object-diff')
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')

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

    start() {
        this.fetchTask = setInterval(async () => {
            console.log("Fetching data");
            const json = await fetchJson(this.jvbUrl);
            this.processJvbJson(json);
        }, 5000);
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
            sendIdentityMessage(confState);
        });
        removedConfIds.forEach(removedConfId => {
            const confState = this.conferenceStates[removedConfId];
            delete this.conferenceStates[removedConfId];
            sendCloseMessage(confState["dumpId"])
        });
    }

    processConference(confId, confData) {
        this.checkForAddedOrRemovedEndpoints(confId, confData["endpoints"]);
        const previousData = this.conferenceStates[confId]["previous_debug_data"] || {};
        const statDiff = diff(previousData, confData);
        sendStatEntryMessage(this.conferenceStates[confId].dumpId, statDiff);
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
            sendIdentityMessage(confState);
        }
    }
}

console.log("argv: ", process.argv);

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

function sendIdentityMessage(/*websocket client,*/ state) {
    // This is a bit awkward: we keep the dumpId in the conference state,
    // but we need to set it as an explicit field of the message.
    const {dumpId, ...metadata} = state;
    const msg = {
        type: "identity",
        dumpId,
        data: JSON.stringify(metadata)
    }
    console.log("created identity message: ", JSON.stringify(msg));
}

function sendCloseMessage(/* websocket client,*/dumpId) {
    const msg = {
        type: "close",
        dumpId
    }
    console.log("created close message: ", JSON.stringify(msg));
}

function sendStatEntryMessage(dumpId, data) {
    const msg = {
        type: "stats-entry",
        dumpId,
        data: JSON.stringify(data)
    }
    // console.log("Created stats entry message: ", JSON.stringify(msg))
}
